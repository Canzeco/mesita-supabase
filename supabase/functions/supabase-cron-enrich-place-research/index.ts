// Supabase Edge Function — supabase-cron-enrich-place-research (artificial caller / cron)
//
// Stage 1 of the Enricher pipeline (the Enricher is a PROCESS — a cron-driven
// pipeline of three EFs — not an agent). The pg_cron poller
// (run_place_enrichment_stages) claims place_research rows at stage='research'
// and fires this EF with { project_id }. It acks 202 immediately and runs the
// RESEARCH half in a background task:
//
//   S1  Google spine re-check (fetchGoogleBasics — hard gate; failure lands
//       terminal stage='failed' + content_status='failed')
//   S2  Apify Google Maps (reviews + images) fired in the BACKGROUND ‖ Perplexity
//       SERP blurb (awaited). GMaps depends only on the place id, so it overlaps
//       S3 + S4 and is collected after the IG/FB scrape — the Apify runs go
//       concurrently instead of GMaps blocking IG/FB.
//   S3  channel discovery (channels ONLY): per-source Firecrawl Search gather
//       (S4) → one Perplexity Agent Y "Review & Select Links" pass (S5). No
//       website-footer scraping. Phone + email are NOT web-searched — they come
//       from Mesita input or the Google spine, and enrichment never clobbers a
//       Mesita-entered contact.
//   S4  parallel gathers: Instagram (Apify + identity judge) ‖ Facebook (Apify),
//       concurrent with the background GMaps scrape from S2
//       (website CONTENT crawl retired — enrichment no longer reads the site)
//
// Output: place_research.gathered (partial place update + grounding + candidate
// image pools + per-image metadata) → stage='analysis'. The profile persists once,
// at the contents stage — the ONE exception is `phone`, written directly to places
// here (see the Contacts note below): it must land only when research re-runs (a
// full re-enrich = override), never on a lighter analysis/contents-only re-run.
//
// Contract: verify_jwt=true; requireInternalCaller gates the service-role bearer.
//
// Local:  supabase functions serve supabase-cron-enrich-place-research
// Deploy: supabase functions deploy supabase-cron-enrich-place-research

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { instagramHandleFromUrl } from "../_shared/apify.ts";
import { resolveChannels } from "../_shared/enrich-channel-discovery.ts";
import { fbSlugCandidate } from "../_shared/channels.ts";
import { loadEnrichConfig } from "../_shared/enrich-config.ts";
import { fetchGoogleBasics } from "../_shared/enrich-google-basics.ts";
import { gatherGoogleMaps } from "../_shared/enrich-google.ts";
import { gatherSerpSummary } from "../_shared/enrich-serp.ts";
import { gatherInstagram, type InstagramResult } from "../_shared/enrich-instagram.ts";
import { type FacebookResult, gatherFacebook } from "../_shared/enrich-facebook.ts";
import {
  advanceResearchStage,
  failResearchRow,
  type GatheredPayload,
  mapToObject,
  releaseResearchRow,
  reportEnrichmentStep,
  serveEnrichStage,
} from "../_shared/enrich-pipeline.ts";

serveEnrichStage("research", async (admin, _env, row) => {
  const projectId = row.project_id;
  const googlePlaceId = row.google_place_id;
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
  const cfg = await loadEnrichConfig(admin);

  const sources: Record<string, unknown> = {};
  const place: Record<string, unknown> = { ...basics };
  const name = basics.name;
  const locationLine = [basics.address, basics.city].filter(Boolean).join(", ");
  const category = basics.category;

  // ━━━ S2 — Apify GMaps reviews (background) ‖ Perplexity SERP blurb ━━━
  // The Google Maps scrape depends only on the place id, NOT on channel
  // resolution, so fire it now and let it overlap S3 discovery + the S4 IG/FB
  // scrape — the two Apify runs then execute concurrently instead of GMaps
  // finishing before IG/FB even starts. It's collected after S4. Reviews are
  // non-critical, so a GMaps failure is recorded in diag, never fatal. SERP is
  // awaited here because it feeds S3 discovery context.
  let reviews: Record<string, unknown>[] = [];
  let reviewCount: number | null = null;
  let googleReviewsText = "";
  let googleImages: string[] = [];
  let serpSummary: string | null = null;

  const gmapsGather = (async () => {
    if (!APIFY_KEY || !basics.google_place_id) return;
    try {
      const g = await gatherGoogleMaps({
        apifyKey: APIFY_KEY,
        placeId: basics.google_place_id,
        gatherGoogleImages: cfg.gatherGoogleImages,
        maxReviews: cfg.gatherReviews,
      });
      reviews = g.reviews;
      reviewCount = g.reviewCount;
      googleReviewsText = g.googleReviewsText;
      googleImages = g.googleImages;
      sources.apify_google_reviews = g.diag;
    } catch (e) {
      sources.apify_google_reviews = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  })();

  if (PERPLEXITY_KEY) {
    const serp = await gatherSerpSummary({ perplexityKey: PERPLEXITY_KEY, name, locationLine, category, perplexityPreset: cfg.perplexityPreset });
    serpSummary = serp.summary;
    sources.serp = serp.diag;
  }

  // ━━━ S3 — channel discovery (channels ONLY) ━━━
  // Phone + email are NOT discovered here: they come from Mesita input (a
  // business editing its own Place) or the Google identity spine, never from a
  // web search. See enrich-channel-discovery.ts. Below we take care never to
  // OVERWRITE a Mesita-entered phone/email with a null (partial-update contract).
  let resolvedInstagram = basics.instagram_url;
  let resolvedFacebook = basics.facebook_url;
  let resolvedWebsite = basics.website_url;
  let resolvedOpenTable = basics.opentable_url;
  let resolvedUberEats = basics.uber_eats_url;
  let resolvedTikTok = basics.tiktok_url;
  let resolvedTripAdvisor = basics.tripadvisor_url;
  let resolvedYelp = basics.yelp_url;

  const needsDiscovery = (!!FIRECRAWL_KEY || !!PERPLEXITY_KEY) &&
    (!resolvedInstagram || !resolvedFacebook || !resolvedWebsite || !resolvedOpenTable ||
      !resolvedUberEats || !resolvedTikTok || !resolvedTripAdvisor || !resolvedYelp);

  if (needsDiscovery) {
    // S4 gather (Firecrawl Search, per-source N) → S5 Agent Y select.
    const found = await resolveChannels({
      firecrawlKey: FIRECRAWL_KEY,
      perplexityKey: PERPLEXITY_KEY,
      name,
      city: basics.city,
      locationLine,
      category,
      serpContext: serpSummary ?? undefined,
      discoverCandidates: cfg.discoverCandidates,
      perplexityPreset: cfg.perplexityPreset,
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

    sources.discovery = {
      ok: true, via: found.via, provenance: found.provenance,
      instagram: !!resolvedInstagram, facebook: !!resolvedFacebook, website: !!resolvedWebsite,
      opentable: !!resolvedOpenTable, ubereats: !!resolvedUberEats, tiktok: !!resolvedTikTok,
      tripadvisor: !!resolvedTripAdvisor, yelp: !!resolvedYelp,
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

  // ━━━ Contacts — phone is persisted HERE, in the research stage only ━━━
  // Phone + email come from Mesita input or the Google spine, never a web search.
  // Only a full re-enrich runs the research stage; the lighter re-enrich modes
  // (analysis / contents only) reuse the STORED `gathered` payload. So if phone
  // rode `gathered.place` into the contents stage, every lighter re-run would
  // re-apply a stale phone and clobber a business edit. Instead phone is written
  // DIRECTLY to places here — i.e. only when research actually re-runs (full
  // re-enrich = override) — and stripped from `gathered.place` so the contents
  // stage never touches it. A null Google phone is never written (it would clobber
  // a Mesita-entered number). Email is never written by the enricher at all.
  if (basics.phone) {
    const { error: phoneErr } = await admin
      .from("places").update({ phone: basics.phone }).eq("id", projectId);
    sources.contact_phone = phoneErr
      ? { ok: false, error: phoneErr.message }
      : { ok: true, source: "google" };
  }
  delete place.phone;
  delete place.email;

  const resolvedCount = ["facebook_url", "website_url", "opentable_url", "uber_eats_url"]
    .filter((k) => !!place[k]).length + (resolvedInstagram ? 1 : 0) + (basics.phone ? 1 : 0);

  const igHandle = instagramHandleFromUrl(resolvedInstagram);
  const fbHandleCandidate = fbSlugCandidate(resolvedFacebook);

  // ━━━ S4 — parallel source gather: IG ‖ FB ━━━
  // Website CONTENT is no longer gathered: enrichment builds description/tags/
  // category from the Google spine + reviews + the Perplexity SERP blurb (+ IG),
  // and never scrapes the site body. S3 discovery is Firecrawl SEARCH only (no
  // footer scrape) → Agent Y selection.
  const runInstagram = !!APIFY_KEY && (!!igHandle || !!fbHandleCandidate || !!PERPLEXITY_KEY);
  const runFacebook = !!APIFY_KEY && !!resolvedFacebook;

  let ig: InstagramResult | null = null;
  let fb: FacebookResult | null = null;
  await Promise.all([
    (async () => {
      if (!runInstagram) return;
      ig = await gatherInstagram({
        apifyKey: APIFY_KEY!,
        openaiKey: OPENAI_KEY,
        perplexityKey: PERPLEXITY_KEY,
        place: { name, locationLine, website: resolvedWebsite, facebook: resolvedFacebook, category },
        igHandle,
        fbHandleCandidate,
        gatherInstagramDepth: cfg.gatherInstagramDepth,
        gatherInstagramPosts: cfg.gatherInstagramPosts,
      });
    })(),
    (async () => {
      if (!runFacebook) return;
      fb = await gatherFacebook({ apifyKey: APIFY_KEY!, facebookUrl: resolvedFacebook! });
    })(),
  ]);
  const igR = ig as InstagramResult | null;
  const fbR = fb as FacebookResult | null;
  if (igR) sources.apify_instagram = igR.diag;
  if (fbR) sources.apify_facebook = fbR.diag;

  // Collect the background Google Maps scrape — it overlapped S3 + S4.
  await gmapsGather;

  // Numeric source facts + verified IG.
  if (reviews.length > 0) {
    place.google_reviews = reviews;
    if (reviewCount != null) place.google_review_count = reviewCount;
  }
  if (igR?.igFollowers != null) place.instagram_followers_count = igR.igFollowers;
  if (fbR?.fbFollowers != null) place.facebook_followers = fbR.fbFollowers;
  if (fbR?.fbRating != null) place.facebook_rating = fbR.fbRating;
  if (igR?.verifiedInstagramUrl) place.instagram_url = igR.verifiedInstagramUrl;

  // Leniency fallback (MESITA-120): when the IG scraper never got a real look
  // (no APIFY key, or every scrape failed at the API layer), attach the
  // independently discovered handle UNVERIFIED rather than nothing — a missing
  // channel is the worse miss. A judge rejection or dead handle still drops it.
  const igUnverifiedFallback = !igR?.verifiedInstagramUrl && !!resolvedInstagram &&
    (!runInstagram || igR?.diag.infra_fail === true);
  if (igUnverifiedFallback) {
    place.instagram_url = resolvedInstagram;
    sources.instagram_fallback = { attached_unverified: true, url: resolvedInstagram };
  }

  // The beacon reports actual gather success, not mere "the call returned"
  // (fbR exists even when the page scrape failed).
  const fbOk = !!fbR && fbR.diag.ok === true;
  const igMark = igR?.verifiedInstagramUrl ? "✓" : igUnverifiedFallback ? "~" : "—";

  // One beacon for the whole research stage (S1–S4) — one notification per
  // function. Summarises everything gathered; granular per-source diag lives
  // in gathered->sources.
  await reportEnrichmentStep(admin, projectId, "S1", "gather", "completed",
    `Research complete for “${name}” — ${basics.photos.length} Google photo(s), ${reviews.length} review(s), ${resolvedCount} link/contact field(s); Instagram ${igMark}, Facebook ${fbOk ? "✓" : "—"}.`,
    {
      photoCount: basics.photos.length,
      reviews: reviews.length,
      serpFound: !!serpSummary,
      resolved: resolvedCount,
      instagram: !!igR?.verifiedInstagramUrl,
      instagram_unverified: igUnverifiedFallback,
      facebook: fbOk,
    });

  // ━━━ hand off to the analysis stage ━━━
  const gathered: GatheredPayload = {
    place,
    grounding: {
      igBio: igR?.igBio ?? "",
      googleReviewsText,
      serpSummary,
    },
    images: {
      google: googleImages,
      instagram: igR?.instagramImages ?? [],
      existingPhotos: basics.photos,
    },
    instagramAssetMeta: mapToObject(igR?.instagramAssetMeta),
    locationLine,
    sources,
  };
  await advanceResearchStage(admin, projectId, "analysis", { gathered });
});
