// Supabase Edge Function — atlas-enrich-place (artificial caller / agent)
//
// Atlas is THE caller/orchestrator for venue profile enrichment. business-create
// -unit seeds the venue from Google Places, then hands it to this agent, which
// runs the Atlas pipeline as an ordered TIER workflow — tasks within a tier run
// in parallel, tiers run in sequence — ending in a grounded synthesis:
//
//   Tier 1  Google contents   Apify Google Maps → reviews, ratings, photos.
//   Tier 2  Links             resolveChannels → all 9 channel links (one pass).
//   Tier 3  Source gather    ∥ Apify Instagram · Apify Facebook · Firecrawl site.
//   Tier 4  Image funnel      vision describe → rubric sort → top-N photos.
//   Final   Synthesis         OpenAI compiles the profile from gathered material
//                             only (no web → can't drift) → infer category → write.
//
// COST CAP: budget is reserved BEFORE each step in a FIXED priority order
// (synthesis → discovery → google → instagram → firecrawl → vision → facebook);
// a step that doesn't fit the remaining per-run USD cap is skipped. The reserve
// order is independent of the tier execution order. CONFIG: every knob lives in
// app_settings, read at run time (the DB is the single source of truth). Every
// source is best-effort + independent; whatever fails degrades to null.
//
// Agent contract: verify_jwt=false; requireInternalCaller gates the service-role
// bearer. Invoked by business-create-unit (on create) and admin-enrich-place
// (re-run). Writes the venue row + enrichment_sources.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller, requireInternalCaller } from "../_shared/internal.ts";
import { instagramHandleFromUrl } from "../_shared/apify.ts";
import { fbSlugCandidate, resolveChannels } from "../_shared/atlas-channel-discovery.ts";
import {
  COST,
  createBudget,
  loadAtlasConfig,
  type MediaAssetPayload,
  PHOTO_CEILING,
} from "../_shared/atlas-config.ts";
import { gatherGoogleMaps } from "../_shared/atlas-google.ts";
import { gatherInstagram, type InstagramResult } from "../_shared/atlas-instagram.ts";
import { type FacebookResult, gatherFacebook } from "../_shared/atlas-facebook.ts";
import { gatherWebsite, type WebsiteResult } from "../_shared/atlas-website.ts";
import { runImageFunnel } from "../_shared/atlas-image-funnel.ts";
import {
  applyProfileToUpdate,
  synthesisModelFor,
  synthesizeProfile,
} from "../_shared/atlas-synthesis.ts";
import { fetchVenueCategories, inferVenueCategory } from "../_shared/categories.ts";
import { humanizeCategorySlug } from "../_shared/parse-utils.ts";

type Body = { venue_id?: string };

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const venueId = (bodyRes.body.venue_id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "venue_id is required" }, 400);

  const admin = adminClient(envRes.env);
  const { data: row } = await admin
    .from("venues")
    .select(
      "name, address, city, category, instagram_url, facebook_url, website_url, opentable_url, uber_eats_url, youtube_url, tiktok_url, tripadvisor_url, yelp_url, google_place_id, google_stars_overall, google_review_count, editorial_summary, photos",
    )
    .eq("id", venueId)
    .maybeSingle();
  if (!row) return json({ ok: false, error: "Venue not found" }, 404);

  // Admin config (app_settings) — read at run time; callers don't pass overrides.
  const cfg = await loadAtlasConfig(admin);

  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_KEY");
  const APIFY_KEY = Deno.env.get("APIFY_KEY");
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_KEY");

  const sources: Record<string, unknown> = {};
  const update: Record<string, unknown> = { enriched_at: new Date().toISOString() };
  const budget = createBudget(cfg.costCapUsd);

  const name = row.name as string;
  const locationLine = [row.address, row.city].filter(Boolean).join(", ");
  const category = (row.category as string | null) ?? null;
  const placeId = typeof row.google_place_id === "string" ? row.google_place_id : null;

  // Channel columns may already carry socials harvested at create time.
  let resolvedInstagram = strOrNull(row.instagram_url);
  let resolvedFacebook = strOrNull(row.facebook_url);
  let resolvedWebsite = strOrNull(row.website_url);
  let resolvedOpenTable = strOrNull(row.opentable_url);
  let resolvedUberEats = strOrNull(row.uber_eats_url);
  let resolvedYouTube = strOrNull(row.youtube_url);
  let resolvedTikTok = strOrNull(row.tiktok_url);
  let resolvedTripAdvisor = strOrNull(row.tripadvisor_url);
  let resolvedYelp = strOrNull(row.yelp_url);

  // ── Budget reservation (FIXED priority order; precedes tier execution) ────
  // Synthesis is core — reserved first so the profile always gets written.
  const synthCost =
    cfg.synthesisQuality === "economy" ? COST.synthesisEconomy : COST.synthesisStandard;
  const runSynthesis = !!OPENAI_KEY && budget.reserve("synthesis", synthCost);

  // Discovery runs whenever a channel is still missing (gate from the seeded
  // links — no execution needed to decide).
  const needsDiscovery =
    cfg.socialLayer &&
    (!!FIRECRAWL_KEY || !!PERPLEXITY_KEY) &&
    (!resolvedInstagram ||
      !resolvedFacebook ||
      !resolvedWebsite ||
      (cfg.reservationDeliveryLayer && (!resolvedOpenTable || !resolvedUberEats)) ||
      (cfg.nicheSocialLayer &&
        (!resolvedYouTube || !resolvedTikTok || !resolvedTripAdvisor || !resolvedYelp)));
  const runDiscovery = needsDiscovery && budget.reserve("discovery", COST.perplexity);

  // Google contents needs only the placeId (independent of discovery), so its
  // budget can be reserved here, keeping the priority order ahead of the social
  // gather reserves (which need discovery's resolved links).
  const runReviews = !!APIFY_KEY && !!placeId && budget.reserve("apify_google", COST.compass);

  // ── Tier 1 — Google business contents ────────────────────────────────────
  let reviews: Record<string, unknown>[] = [];
  let reviewCount: number | null = null;
  let googleReviewsText = "";
  let googleImages: string[] = [];
  if (runReviews) {
    const g = await gatherGoogleMaps({
      apifyKey: APIFY_KEY!,
      placeId: placeId!,
      gatherGoogleImages: cfg.gatherGoogleImages,
    });
    reviews = g.reviews;
    reviewCount = g.reviewCount;
    googleReviewsText = g.googleReviewsText;
    googleImages = g.googleImages;
    sources.apify_google_reviews = g.diag;
  }

  // ── Tier 2 — Link discovery (all channels in one pass) ───────────────────
  if (runDiscovery) {
    const found = await resolveChannels({
      firecrawlKey: FIRECRAWL_KEY,
      perplexityKey: PERPLEXITY_KEY,
      name,
      city: (row.city as string | null) ?? null,
      locationLine,
      category,
      resolveReservationDelivery: cfg.reservationDeliveryLayer,
      resolveNicheSocial: cfg.nicheSocialLayer,
      have: {
        instagram: resolvedInstagram,
        facebook: resolvedFacebook,
        website: resolvedWebsite,
        opentable: resolvedOpenTable,
        uberEats: resolvedUberEats,
        youtube: resolvedYouTube,
        tiktok: resolvedTikTok,
        tripadvisor: resolvedTripAdvisor,
        yelp: resolvedYelp,
      },
    });
    if (!resolvedInstagram && found.instagram_url) resolvedInstagram = found.instagram_url;
    if (!resolvedFacebook && found.facebook_url) resolvedFacebook = found.facebook_url;
    if (!resolvedWebsite && found.website_url) resolvedWebsite = found.website_url;
    if (cfg.reservationDeliveryLayer) {
      if (!resolvedOpenTable && found.opentable_url) resolvedOpenTable = found.opentable_url;
      if (!resolvedUberEats && found.uber_eats_url) resolvedUberEats = found.uber_eats_url;
    }
    if (cfg.nicheSocialLayer) {
      if (!resolvedYouTube && found.youtube_url) resolvedYouTube = found.youtube_url;
      if (!resolvedTikTok && found.tiktok_url) resolvedTikTok = found.tiktok_url;
      if (!resolvedTripAdvisor && found.tripadvisor_url) resolvedTripAdvisor = found.tripadvisor_url;
      if (!resolvedYelp && found.yelp_url) resolvedYelp = found.yelp_url;
    }
    sources.discovery = {
      ok: true,
      via: found.via,
      provenance: found.provenance,
      instagram: !!resolvedInstagram,
      facebook: !!resolvedFacebook,
      website: !!resolvedWebsite,
      opentable: !!resolvedOpenTable,
      ubereats: !!resolvedUberEats,
      youtube: !!resolvedYouTube,
      tiktok: !!resolvedTikTok,
      tripadvisor: !!resolvedTripAdvisor,
      yelp: !!resolvedYelp,
    };
  }

  // Persist newly resolved channels. instagram_url is deliberately NOT persisted
  // here — for a generic name the searched candidate may be a different same-
  // named account, so it persists only AFTER the IG scrape verifies it (Tier 3).
  if (resolvedFacebook && resolvedFacebook !== row.facebook_url) update.facebook_url = resolvedFacebook;
  if (resolvedWebsite && resolvedWebsite !== row.website_url) update.website_url = resolvedWebsite;
  // OpenTable/UberEats + niche socials are host + shape-validated links (no per-
  // venue identity check the way Instagram needs), so they persist straight away.
  if (resolvedOpenTable && resolvedOpenTable !== row.opentable_url) update.opentable_url = resolvedOpenTable;
  if (resolvedUberEats && resolvedUberEats !== row.uber_eats_url) update.uber_eats_url = resolvedUberEats;
  if (resolvedYouTube && resolvedYouTube !== row.youtube_url) update.youtube_url = resolvedYouTube;
  if (resolvedTikTok && resolvedTikTok !== row.tiktok_url) update.tiktok_url = resolvedTikTok;
  if (resolvedTripAdvisor && resolvedTripAdvisor !== row.tripadvisor_url) update.tripadvisor_url = resolvedTripAdvisor;
  if (resolvedYelp && resolvedYelp !== row.yelp_url) update.yelp_url = resolvedYelp;

  const igHandle = instagramHandleFromUrl(resolvedInstagram);
  const fbHandleCandidate = fbSlugCandidate(resolvedFacebook);

  // ── Tier 3 — Source content gather (parallel; depends on Tier 2 links) ───
  // Run IG whenever we have ANY way to reach a candidate (resolved handle, the
  // FB slug reused as a handle, or a Perplexity lookup) — every candidate is
  // verify-gated, so widening the gate never attaches a wrong account.
  const canDiscoverIg = !!igHandle || !!fbHandleCandidate || !!PERPLEXITY_KEY;
  const runInstagram =
    cfg.socialLayer && !!APIFY_KEY && canDiscoverIg &&
    budget.reserve("apify_instagram", COST.instagram + COST.instagramVerify);
  const runWebsite =
    cfg.socialLayer && !!FIRECRAWL_KEY && !!resolvedWebsite &&
    budget.reserve("firecrawl", COST.firecrawl * cfg.websiteCrawlMaxPages + COST.sort);
  const maxVisionImages = cfg.visionEnabled
    ? cfg.analyzeGoogleImages + cfg.analyzeWebsiteImages + cfg.analyzeInstagramImages
    : 0;
  const runVision =
    cfg.visionEnabled && !!OPENAI_KEY && maxVisionImages > 0 &&
    budget.reserve("vision", maxVisionImages * COST.visionPerImage + COST.sort);
  const runFacebook =
    cfg.socialLayer && !!APIFY_KEY && !!resolvedFacebook &&
    budget.reserve("apify_facebook", COST.facebook);

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
        venue: {
          name,
          locationLine,
          website: resolvedWebsite,
          facebook: resolvedFacebook,
          category,
        },
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

  // Persist the numeric source facts.
  if (reviews.length > 0) {
    update.google_reviews = reviews;
    if (reviewCount != null) update.google_review_count = reviewCount;
  }
  if (igR?.igFollowers != null) update.instagram_followers_count = igR.igFollowers;
  if (fbR?.fbFollowers != null) update.facebook_followers = fbR.fbFollowers;
  if (fbR?.fbRating != null) update.facebook_rating = fbR.fbRating;
  // Persist instagram_url ONLY if the scrape verified it belongs to this venue.
  if (igR?.verifiedInstagramUrl && igR.verifiedInstagramUrl !== row.instagram_url) {
    update.instagram_url = igR.verifiedInstagramUrl;
  }

  // ── Tier 4 — Image funnel (gather pool → analyze → sort → save top-N) ────
  const funnel = await runImageFunnel({
    googleImages,
    websiteImages,
    instagramImages,
    existingPhotos: Array.isArray(row.photos) ? (row.photos as string[]) : [],
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
  if (funnel.finalPhotos.length > 0) update.photos = funnel.finalPhotos;
  sources.image_funnel = funnel.diag;

  // ── Final — grounded synthesis (Research Backbone) + category + persist ──
  if (!OPENAI_KEY) return json({ ok: false, error: "OPENAI_KEY not configured" }, 500);
  const synthesisModel = synthesisModelFor(cfg.synthesisQuality);
  if (runSynthesis) {
    const { parsed, diag } = await synthesizeProfile({
      openaiKey: OPENAI_KEY,
      model: synthesisModel,
      name,
      locationLine,
      category,
      igBio,
      googleReviewsText,
      siteMarkdown,
    });
    sources.synthesis = diag;
    if (parsed) applyProfileToUpdate(update, parsed);
  } else {
    sources.synthesis = { ok: false, reason: "cost_cap" };
  }

  // Category inference (dynamic vocabulary from venue_categories). Prefers the
  // freshly synthesised editorial summary, hence it runs AFTER synthesis.
  const categoryList = await fetchVenueCategories(admin);
  const inferredCategory = await inferVenueCategory(OPENAI_KEY, categoryList, {
    name,
    address: (row.address as string | null) ?? null,
    editorialSummary:
      (update.editorial_summary as string | undefined) ??
      (row.editorial_summary as string | null) ??
      null,
    description: igBio || siteMarkdown.slice(0, 1200) || null,
  });
  if (inferredCategory) {
    update.category = inferredCategory;
    update.category_label =
      categoryList.find((c) => c.slug === inferredCategory)?.label ??
      humanizeCategorySlug(inferredCategory) ?? inferredCategory;
  }
  sources.category = {
    ok: !!inferredCategory,
    slug: inferredCategory,
    candidates: categoryList.length,
  };

  // Cost accounting.
  sources.cost = {
    cap_usd: cfg.costCapUsd,
    estimated_usd: Math.round(budget.spent() * 1000) / 1000,
    breakdown: budget.cost,
  };
  update.enrichment_sources = sources;

  const { error: updErr } = await admin.from("venues").update(update).eq("id", venueId);
  if (updErr) return json({ ok: false, error: `venue_update: ${updErr.message}` }, 500);

  // Queue media persistence asynchronously: keep source URLs in the runtime
  // response for speed, then mirror + metadata-save in background.
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
  let mediaAsync: Record<string, unknown> = { queued: false, assets: mediaAssets.length };
  if (mediaAssets.length > 0) {
    const mediaRes = await invokeArtificialCaller(
      envRes.env,
      "atlas-enrich-place",
      "atlas-save-place-media",
      { venue_id: venueId, assets: mediaAssets, preferred_photo_urls: funnel.finalPhotos },
    );
    mediaAsync = mediaRes.ok
      ? { queued: true, assets: mediaAssets.length }
      : { queued: false, assets: mediaAssets.length, error: mediaRes.error, status: mediaRes.status };
  }

  return json({
    ok: true,
    venue_id: venueId,
    sources,
    fields_filled: Object.keys(update).filter(
      (k) => k !== "enriched_at" && k !== "enrichment_sources",
    ),
    media_async: mediaAsync,
    caller: callerRes.callerName,
  });
});
