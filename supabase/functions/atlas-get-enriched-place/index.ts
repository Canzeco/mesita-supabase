// Supabase Edge Function — atlas-get-enriched-place (ADEA, read-only)
//
// THE create-pipeline compute step. Folds the old atlas-seed-place (Google
// basics) + atlas-enrich-place (the full ADEA pipeline) into ONE synchronous,
// READ-ONLY function: given a Google `placeId` it builds the identity spine in
// memory, runs every ADEA step, and RETURNS the finished `places` profile +
// media assets as JSON. It writes NOTHING — the caller persists via
// atlas-save-unit-data (units+places row) then atlas-save-place-media (photos).
//
// The four create callers (business-create-unit, admin-create-unit,
// consumer/admin-schedule-unit-creation) await this, then save.
//
// Steps (every step runs on its prerequisites; no admin ceiling):
//   S0 Google basics  fetchGoogleBasics → identity spine (name/geo/links/photos)
//   S1 Google data    Apify Google Maps → reviews, ratings, images
//   S2 SERP summary   Perplexity P2 → soft editorial color (grounds S3 + S5)
//   S3 Link discovery website-first + P3 gap-fill (socials, phone, email)
//   S4 Source gather  ∥ Apify Instagram · Apify Facebook · Firecrawl website
//   S5 Perceive+write image vision funnel → OpenAI synthesis → About+tags+category
//
// DB touch: read-only — app_settings (config) + venue_categories (vocabulary).
// No venue/unit/place writes, no adea_status flips. Contract: verify_jwt=false;
// requireInternalCaller gates the service-role bearer.
//
// Local:  supabase functions serve atlas-get-enriched-place
// Deploy: supabase functions deploy atlas-get-enriched-place

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
import { loadAtlasConfig, type MediaAssetPayload, PHOTO_CEILING } from "../_shared/atlas-config.ts";
import { gatherGoogleMaps } from "../_shared/atlas-google.ts";
import { gatherSerpSummary } from "../_shared/atlas-serp.ts";
import { gatherInstagram, type InstagramResult } from "../_shared/atlas-instagram.ts";
import { type FacebookResult, gatherFacebook } from "../_shared/atlas-facebook.ts";
import { gatherWebsite, type WebsiteResult } from "../_shared/atlas-website.ts";
import { runImageFunnel } from "../_shared/atlas-image-funnel.ts";
import { applyProfileToUpdate, synthesisModelFor, synthesizeProfile } from "../_shared/atlas-synthesis.ts";
import { fetchVenueCategories, inferVenueCategory } from "../_shared/categories.ts";
import { humanizeCategorySlug } from "../_shared/parse-utils.ts";
import { fetchGoogleBasics } from "../_shared/atlas-google-basics.ts";

type Body = { placeId?: string };

Deno.serve(async (req) => {
  // ━━━ guards ━━━
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;
  const callerRes = requireInternalCaller(req, env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  const GOOGLE_KEY = Deno.env.get("GMP_KEY") ?? Deno.env.get("SUPA_GMP_KEY");
  if (!GOOGLE_KEY) return json({ ok: false, error: "Server misconfigured (missing core secrets)" }, 500);

  // ━━━ S0 — Google basics (identity spine, in memory) ━━━
  const basicsRes = await fetchGoogleBasics(placeId, GOOGLE_KEY);
  if (!basicsRes.ok) {
    return json({ ok: false, code: basicsRes.code, error: basicsRes.error }, basicsRes.status);
  }
  const basics = basicsRes.basics;

  // The finished profile starts as the Google spine; every step below overwrites
  // its own fields. This object is `places`-shaped and is what we return.
  const place: Record<string, unknown> = { ...basics };

  // ━━━ config & keys ━━━
  const admin = adminClient(env); // READ-ONLY: config + category vocabulary
  const cfg = await loadAtlasConfig(admin);
  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_KEY");
  const APIFY_KEY = Deno.env.get("APIFY_KEY");
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_KEY");

  const sources: Record<string, unknown> = {};
  const name = basics.name;
  const locationLine = [basics.address, basics.city].filter(Boolean).join(", ");
  const category = basics.category;

  // Channels seeded from Google; discovery fills the gaps.
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

  const needsDiscovery =
    (!!FIRECRAWL_KEY || !!PERPLEXITY_KEY) &&
    (!resolvedInstagram || !resolvedFacebook || !resolvedWebsite || !resolvedOpenTable ||
      !resolvedUberEats || !resolvedTikTok || !resolvedTripAdvisor || !resolvedYelp ||
      !resolvedPhone || !resolvedEmail);
  const runReviews = !!APIFY_KEY && !!basics.google_place_id;

  // ━━━ S1 — Google business contents (Apify) ━━━
  let reviews: Record<string, unknown>[] = [];
  let reviewCount: number | null = null;
  let googleReviewsText = "";
  let googleImages: string[] = [];
  if (runReviews) {
    const g = await gatherGoogleMaps({
      apifyKey: APIFY_KEY!,
      placeId: basics.google_place_id,
      gatherGoogleImages: cfg.gatherGoogleImages,
    });
    reviews = g.reviews;
    reviewCount = g.reviewCount;
    googleReviewsText = g.googleReviewsText;
    googleImages = g.googleImages;
    sources.apify_google_reviews = g.diag;
  }

  // ━━━ S2 — SERP summary (Perplexity P2, soft context) ━━━
  let serpSummary: string | null = null;
  if (PERPLEXITY_KEY) {
    const serp = await gatherSerpSummary({ perplexityKey: PERPLEXITY_KEY, name, locationLine, category });
    serpSummary = serp.summary;
    sources.serp = serp.diag;
  }

  // ━━━ S3 — link discovery (website-first; P3 fills gaps + phone/email) ━━━
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

    let phoneVia: string | null = null;
    if (!resolvedPhone && PERPLEXITY_KEY) {
      const phone = await discoverPhonePerplexity(PERPLEXITY_KEY, name, locationLine, category, {
        website: resolvedWebsite,
        serpContext: serpSummary ?? undefined,
      });
      if (phone) { resolvedPhone = phone; phoneVia = "perplexity"; }
    }
    let emailVia: string | null = null;
    if (!resolvedEmail && PERPLEXITY_KEY) {
      const email = await discoverEmailPerplexity(PERPLEXITY_KEY, name, locationLine, category, {
        website: resolvedWebsite,
        serpContext: serpSummary ?? undefined,
      });
      if (email) { resolvedEmail = email; emailVia = "perplexity"; }
    }
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

  const igHandle = instagramHandleFromUrl(resolvedInstagram);
  const fbHandleCandidate = fbSlugCandidate(resolvedFacebook);

  // ━━━ S4 — source gather (parallel) ━━━
  const canDiscoverIg = !!igHandle || !!fbHandleCandidate || !!PERPLEXITY_KEY;
  const runInstagram = !!APIFY_KEY && canDiscoverIg;
  const runWebsite = !!FIRECRAWL_KEY && !!resolvedWebsite;
  const maxVisionImages = cfg.visionEnabled
    ? cfg.analyzeGoogleImages + cfg.analyzeWebsiteImages + cfg.analyzeInstagramImages
    : 0;
  const runVision = cfg.visionEnabled && !!OPENAI_KEY && maxVisionImages > 0;
  const runFacebook = !!APIFY_KEY && !!resolvedFacebook;

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

  const igBio = igR?.igBio ?? "";
  const siteMarkdown = webR?.siteMarkdown ?? "";
  const instagramImages = igR?.instagramImages ?? [];
  const websiteImages = webR?.websiteImages ?? [];

  // Numeric source facts.
  if (reviews.length > 0) {
    place.google_reviews = reviews;
    if (reviewCount != null) place.google_review_count = reviewCount;
  }
  if (igR?.igFollowers != null) place.instagram_followers_count = igR.igFollowers;
  if (fbR?.fbFollowers != null) place.facebook_followers = fbR.fbFollowers;
  if (fbR?.fbRating != null) place.facebook_rating = fbR.fbRating;
  // Persist instagram_url ONLY once the scrape verified it belongs to this venue
  // (a searched candidate may be a different same-named account). Otherwise the
  // profile keeps the Google-seed value (place started as {...basics}).
  if (igR?.verifiedInstagramUrl) place.instagram_url = igR.verifiedInstagramUrl;

  // ━━━ S5 — image perception + grounded synthesis + category ━━━
  const funnel = await runImageFunnel({
    googleImages,
    websiteImages,
    instagramImages,
    existingPhotos: basics.photos,
    gatherGoogleImages: cfg.gatherGoogleImages,
    saveTotalImages: cfg.saveTotalImages,
    photoCeiling: PHOTO_CEILING,
    runVision,
    openaiKey: OPENAI_KEY,
    analyze: {
      google: cfg.analyzeGoogleImages,
      website: cfg.analyzeWebsiteImages,
      instagram: cfg.analyzeInstagramImages,
    },
    imageAnalysisPrompt: cfg.imageAnalysisPrompt,
    imageSortingPrompt: cfg.imageSortingPrompt,
  });
  if (funnel.finalPhotos.length > 0) place.photos = funnel.finalPhotos;
  sources.image_funnel = funnel.diag;

  if (!OPENAI_KEY) return json({ ok: false, error: "OPENAI_KEY not configured" }, 500);
  const { parsed, diag } = await synthesizeProfile({
    openaiKey: OPENAI_KEY,
    model: synthesisModelFor(cfg.synthesisQuality),
    name,
    locationLine,
    category,
    igBio,
    googleReviewsText,
    siteMarkdown,
    serpSummary,
  });
  sources.synthesis = diag;
  if (parsed) applyProfileToUpdate(place, parsed);

  // Category inference (dynamic vocabulary); runs after synthesis so it can read
  // the fresh editorial summary.
  const categoryList = await fetchVenueCategories(admin);
  const inferredCategory = await inferVenueCategory(OPENAI_KEY, categoryList, {
    name,
    address: basics.address,
    editorialSummary: (place.editorial_summary as string | undefined) ?? basics.editorial_summary ?? null,
    description: igBio || siteMarkdown.slice(0, 1200) || null,
  });
  if (inferredCategory) {
    place.category = inferredCategory;
    place.category_label =
      categoryList.find((c) => c.slug === inferredCategory)?.label ??
      humanizeCategorySlug(inferredCategory) ?? inferredCategory;
  }
  sources.category = { ok: !!inferredCategory, slug: inferredCategory, candidates: categoryList.length };

  place.enriched_at = new Date().toISOString();
  place.enrichment_sources = sources;

  // ━━━ media assets (returned, not persisted — the caller saves them) ━━━
  const instagramAssetMeta = igR?.instagramAssetMeta ?? null;
  const websiteAssetMeta = webR?.websiteAssetMeta ?? null;
  const mediaAssets: MediaAssetPayload[] = funnel.saved.map((img) => {
    const im = instagramAssetMeta?.get(img.url);
    const wm = websiteAssetMeta?.get(img.url);
    return {
      source: img.source,
      source_url: img.url,
      likes_count: im?.likes_count ?? null,
      caption: im?.caption ?? null,
      analysis: funnel.imageAnalysisByUrl.get(img.url) ?? null,
      source_metadata: im?.source_metadata ?? wm ?? null,
    };
  });

  // ━━━ respond — full profile JSON; ZERO DB writes ━━━
  return json({
    ok: true,
    place,
    media_assets: mediaAssets,
    preferred_photo_urls: funnel.finalPhotos,
    sources,
    fields_filled: Object.keys(place).filter((k) => k !== "enriched_at" && k !== "enrichment_sources"),
    caller: callerRes.callerName,
  });
});
