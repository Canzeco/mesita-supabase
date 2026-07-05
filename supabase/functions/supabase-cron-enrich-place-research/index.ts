// Supabase Edge Function — supabase-cron-enrich-place-research (artificial caller / cron)
//
// Stage 1 of the Enricher v2 pipeline (the Enricher is a PROCESS now — a
// cron-driven pipeline of three EFs — not an n8n agent). The pg_cron poller
// (run_place_enrichment_stages) claims place_research rows at stage='research'
// and fires this EF with { project_id }. It acks 200 immediately and runs the
// RESEARCH half in a background task:
//
//   S1  Google spine re-check (fetchGoogleBasics — hard gate; failure lands
//       terminal stage='failed' + content_status='failed')
//   S2  parallel: Apify Google Maps (reviews + images) ‖ Perplexity SERP blurb
//   S3  channel discovery (website-first Firecrawl + one Perplexity fill) +
//       phone/email last-resort lookups
//   S4  parallel gathers: Instagram (Apify + identity judge) ‖ Facebook (Apify)
//       ‖ Website (Firecrawl crawl + image extraction)
//
// Output: place_research.gathered (partial place update + grounding + candidate
// image pools + per-image metadata) → stage='analysis'. No places writes here —
// persistence happens once, at the contents stage.
//
// Contract: verify_jwt=true; requireInternalCaller gates the service-role bearer.
//
// Local:  supabase functions serve supabase-cron-enrich-place-research
// Deploy: supabase functions deploy supabase-cron-enrich-place-research

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import { instagramHandleFromUrl } from "../_shared/apify.ts";
import {
  discoverEmailPerplexity,
  discoverPhonePerplexity,
  resolveChannels,
} from "../_shared/atlas-channel-discovery.ts";
import { fbSlugCandidate } from "../_shared/channels.ts";
import { loadAtlasConfig } from "../_shared/atlas-config.ts";
import { fetchGoogleBasics } from "../_shared/atlas-google-basics.ts";
import { gatherGoogleMaps } from "../_shared/atlas-google.ts";
import { gatherSerpSummary } from "../_shared/atlas-serp.ts";
import { gatherInstagram, type InstagramResult } from "../_shared/atlas-instagram.ts";
import { type FacebookResult, gatherFacebook } from "../_shared/atlas-facebook.ts";
import { gatherWebsite, type WebsiteResult } from "../_shared/atlas-website.ts";
import {
  advanceResearchStage,
  failResearchRow,
  type GatheredPayload,
  loadClaimedRow,
  mapToObject,
  releaseResearchRow,
  reportEnrichmentStep,
  runInBackground,
} from "../_shared/enrich-pipeline.ts";

type Body = { project_id?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;
  const callerRes = requireInternalCaller(req, env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const projectId = (bodyRes.body.project_id ?? "").toString().trim();
  if (!projectId) return json({ ok: false, error: "project_id is required" }, 400);

  const admin = adminClient(env);
  const rowRes = await loadClaimedRow(admin, projectId, "research");
  if (!rowRes.ok) return json({ ok: false, error: rowRes.reason }, 409);

  // Ack now; research runs in the background within this worker's wall clock.
  runInBackground(runResearch(admin, projectId, rowRes.row.google_place_id));
  return json({ ok: true, accepted: true, stage: "research", project_id: projectId }, 202);
});

async function runResearch(
  admin: ReturnType<typeof adminClient>,
  projectId: string,
  googlePlaceId: string,
): Promise<void> {
  try {
    const GOOGLE_KEY = Deno.env.get("GMP_KEY") ?? Deno.env.get("SUPA_GMP_KEY");
    if (!GOOGLE_KEY) {
      await releaseResearchRow(admin, projectId, "server_misconfigured: missing GMP_KEY");
      return;
    }
    const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
    const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_KEY");
    const APIFY_KEY = Deno.env.get("APIFY_KEY");
    const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_KEY");

    // ━━━ S1 — Google identity spine (hard gate) ━━━
    const basicsRes = await fetchGoogleBasics(googlePlaceId, GOOGLE_KEY);
    if (!basicsRes.ok) {
      if (basicsRes.status === 422) {
        // Spine incomplete — not retryable. Terminal fail.
        await reportEnrichmentStep(admin, projectId, "S1", "google_profile", "failed",
          "Google identity spine incomplete — no reliable Google Places match, so the enrichment run was aborted.");
        await failResearchRow(admin, projectId, `google_spine: ${basicsRes.error}`);
      } else {
        // Transient Google trouble — release for a retry.
        await releaseResearchRow(admin, projectId, `google_basics: ${basicsRes.error}`);
      }
      return;
    }
    const basics = basicsRes.basics;
    const cfg = await loadAtlasConfig(admin);

    const sources: Record<string, unknown> = {};
    const place: Record<string, unknown> = { ...basics };
    const name = basics.name;
    const locationLine = [basics.address, basics.city].filter(Boolean).join(", ");
    const category = basics.category;

    await reportEnrichmentStep(admin, projectId, "S1", "google_profile", "completed",
      `Google profile confirmed for “${name}” — identity spine locked with ${basics.photos.length} photo(s).`,
      { photoCount: basics.photos.length });

    // ━━━ S2 — parallel: Apify GMaps reviews ‖ Perplexity SERP blurb ━━━
    let reviews: Record<string, unknown>[] = [];
    let reviewCount: number | null = null;
    let googleReviewsText = "";
    let googleImages: string[] = [];
    let serpSummary: string | null = null;
    await Promise.all([
      (async () => {
        if (!APIFY_KEY || !basics.google_place_id) return;
        const g = await gatherGoogleMaps({
          apifyKey: APIFY_KEY,
          placeId: basics.google_place_id,
          gatherGoogleImages: cfg.gatherGoogleImages,
        });
        reviews = g.reviews;
        reviewCount = g.reviewCount;
        googleReviewsText = g.googleReviewsText;
        googleImages = g.googleImages;
        sources.apify_google_reviews = g.diag;
      })(),
      (async () => {
        if (!PERPLEXITY_KEY) return;
        const serp = await gatherSerpSummary({ perplexityKey: PERPLEXITY_KEY, name, locationLine, category });
        serpSummary = serp.summary;
        sources.serp = serp.diag;
      })(),
    ]);
    await reportEnrichmentStep(admin, projectId, "S2", "reviews_and_serp", "completed",
      `Research gathered — ${reviews.length} Google review(s) pulled${serpSummary ? " and a web editorial blurb found." : "; no editorial blurb found."}`,
      { reviews: reviews.length, serpFound: !!serpSummary });

    // ━━━ S3 — channel discovery + phone/email ━━━
    let resolvedInstagram = basics.instagram_url;
    let resolvedFacebook = basics.facebook_url;
    let resolvedWebsite = basics.website_url;
    let resolvedOpenTable = basics.opentable_url;
    let resolvedUberEats = basics.uber_eats_url;
    let resolvedTikTok = basics.tiktok_url;
    let resolvedTripAdvisor = basics.tripadvisor_url;
    let resolvedYelp = basics.yelp_url;
    let resolvedPhone = basics.phone;
    let resolvedEmail = basics.email;

    const needsDiscovery = (!!FIRECRAWL_KEY || !!PERPLEXITY_KEY) &&
      (!resolvedInstagram || !resolvedFacebook || !resolvedWebsite || !resolvedOpenTable ||
        !resolvedUberEats || !resolvedTikTok || !resolvedTripAdvisor || !resolvedYelp ||
        !resolvedPhone || !resolvedEmail);

    if (needsDiscovery) {
      const found = await resolveChannels({
        firecrawlKey: FIRECRAWL_KEY,
        perplexityKey: PERPLEXITY_KEY,
        name,
        city: basics.city,
        locationLine,
        category,
        serpContext: serpSummary ?? undefined,
        have: {
          instagram: resolvedInstagram,
          facebook: resolvedFacebook,
          website: resolvedWebsite,
          opentable: resolvedOpenTable,
          uberEats: resolvedUberEats,
          tiktok: resolvedTikTok,
          tripadvisor: resolvedTripAdvisor,
          yelp: resolvedYelp,
        },
      });
      if (!resolvedInstagram && found.instagram_url) resolvedInstagram = found.instagram_url;
      if (!resolvedFacebook && found.facebook_url) resolvedFacebook = found.facebook_url;
      if (!resolvedWebsite && found.website_url) resolvedWebsite = found.website_url;
      if (!resolvedOpenTable && found.opentable_url) resolvedOpenTable = found.opentable_url;
      if (!resolvedUberEats && found.uber_eats_url) resolvedUberEats = found.uber_eats_url;
      if (!resolvedTikTok && found.tiktok_url) resolvedTikTok = found.tiktok_url;
      if (!resolvedTripAdvisor && found.tripadvisor_url) resolvedTripAdvisor = found.tripadvisor_url;
      if (!resolvedYelp && found.yelp_url) resolvedYelp = found.yelp_url;

      // Phone + email in parallel (each a single Perplexity agent call).
      let phoneVia: string | null = null;
      let emailVia: string | null = null;
      await Promise.all([
        (async () => {
          if (resolvedPhone || !PERPLEXITY_KEY) return;
          const phone = await discoverPhonePerplexity(PERPLEXITY_KEY, name, locationLine, category, {
            website: resolvedWebsite,
            serpContext: serpSummary ?? undefined,
          });
          if (phone) { resolvedPhone = phone; phoneVia = "perplexity"; }
        })(),
        (async () => {
          if (resolvedEmail || !PERPLEXITY_KEY) return;
          const email = await discoverEmailPerplexity(PERPLEXITY_KEY, name, locationLine, category, {
            website: resolvedWebsite,
            serpContext: serpSummary ?? undefined,
          });
          if (email) { resolvedEmail = email; emailVia = "perplexity"; }
        })(),
      ]);
      sources.discovery = {
        ok: true, via: found.via, provenance: found.provenance,
        instagram: !!resolvedInstagram, facebook: !!resolvedFacebook, website: !!resolvedWebsite,
        opentable: !!resolvedOpenTable, ubereats: !!resolvedUberEats, tiktok: !!resolvedTikTok,
        tripadvisor: !!resolvedTripAdvisor, yelp: !!resolvedYelp,
        phone: !!resolvedPhone, phone_via: phoneVia, email: !!resolvedEmail, email_via: emailVia,
      };
    }

    // Fold resolved channels into the profile. instagram_url waits for S4 verify.
    place.facebook_url = resolvedFacebook;
    place.website_url = resolvedWebsite;
    place.opentable_url = resolvedOpenTable;
    place.uber_eats_url = resolvedUberEats;
    place.tiktok_url = resolvedTikTok;
    place.tripadvisor_url = resolvedTripAdvisor;
    place.yelp_url = resolvedYelp;
    place.phone = resolvedPhone;
    place.email = resolvedEmail;

    const resolvedCount = ["facebook_url", "website_url", "opentable_url", "uber_eats_url", "phone", "email"]
      .filter((k) => !!place[k]).length + (resolvedInstagram ? 1 : 0);
    await reportEnrichmentStep(admin, projectId, "S3", "links_and_contacts", "completed",
      `Channel discovery done — resolved ${resolvedCount} official link/contact field(s) (website, socials, phone, email).`,
      { resolved: resolvedCount });

    const igHandle = instagramHandleFromUrl(resolvedInstagram);
    const fbHandleCandidate = fbSlugCandidate(resolvedFacebook);

    // ━━━ S4 — parallel source gather: IG ‖ FB ‖ Website ━━━
    const runInstagram = !!APIFY_KEY && (!!igHandle || !!fbHandleCandidate || !!PERPLEXITY_KEY);
    const runFacebook = !!APIFY_KEY && !!resolvedFacebook;
    const runWebsite = !!FIRECRAWL_KEY && !!resolvedWebsite;

    let ig: InstagramResult | null = null;
    let fb: FacebookResult | null = null;
    let web: WebsiteResult | null = null;
    await Promise.all([
      (async () => {
        if (!runInstagram) return;
        ig = await gatherInstagram({
          apifyKey: APIFY_KEY!,
          openaiKey: OPENAI_KEY,
          perplexityKey: PERPLEXITY_KEY,
          venue: { name, locationLine, website: resolvedWebsite, facebook: resolvedFacebook, category },
          igHandle,
          fbHandleCandidate,
          gatherInstagramPosts: cfg.gatherInstagramPosts,
        });
      })(),
      (async () => {
        if (!runFacebook) return;
        fb = await gatherFacebook({ apifyKey: APIFY_KEY!, facebookUrl: resolvedFacebook! });
      })(),
      (async () => {
        if (!runWebsite) return;
        web = await gatherWebsite({
          firecrawlKey: FIRECRAWL_KEY!,
          openaiKey: OPENAI_KEY,
          websiteUrl: resolvedWebsite!,
          websiteCrawlMaxPages: cfg.websiteCrawlMaxPages,
          gatherWebsiteImages: cfg.gatherWebsiteImages,
        });
      })(),
    ]);
    const igR = ig as InstagramResult | null;
    const fbR = fb as FacebookResult | null;
    const webR = web as WebsiteResult | null;
    if (igR) sources.apify_instagram = igR.diag;
    if (fbR) sources.apify_facebook = fbR.diag;
    if (webR) sources.firecrawl = webR.diag;

    // Numeric source facts + verified IG.
    if (reviews.length > 0) {
      place.google_reviews = reviews;
      if (reviewCount != null) place.google_review_count = reviewCount;
    }
    if (igR?.igFollowers != null) place.instagram_followers_count = igR.igFollowers;
    if (fbR?.fbFollowers != null) place.facebook_followers = fbR.fbFollowers;
    if (fbR?.fbRating != null) place.facebook_rating = fbR.fbRating;
    if (igR?.verifiedInstagramUrl) place.instagram_url = igR.verifiedInstagramUrl;

    await reportEnrichmentStep(admin, projectId, "S4", "source_harvest", "completed",
      `Source harvest complete — Instagram ${igR?.verifiedInstagramUrl ? "✓" : "—"}, Facebook ${fbR ? "✓" : "—"}, website ${webR ? "✓" : "—"}.`,
      { instagram: !!igR?.verifiedInstagramUrl, facebook: !!fbR, website: !!webR });

    // ━━━ hand off to the analysis stage ━━━
    const gathered: GatheredPayload = {
      place,
      grounding: {
        igBio: igR?.igBio ?? "",
        googleReviewsText,
        siteMarkdown: webR?.siteMarkdown ?? "",
        serpSummary,
      },
      images: {
        google: googleImages,
        website: webR?.websiteImages ?? [],
        instagram: igR?.instagramImages ?? [],
        existingPhotos: basics.photos,
      },
      instagramAssetMeta: mapToObject(igR?.instagramAssetMeta),
      websiteAssetMeta: mapToObject(webR?.websiteAssetMeta),
      locationLine,
      sources,
    };
    await advanceResearchStage(admin, projectId, "analysis", { gathered });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[supabase-cron-enrich-place-research]", msg);
    await releaseResearchRow(admin, projectId, `research_crash: ${msg}`);
  }
}
