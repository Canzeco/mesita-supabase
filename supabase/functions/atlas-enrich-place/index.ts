// Supabase Edge Function — atlas-enrich-place (artificial caller / agent)
//
// Atlas is THE caller/orchestrator for venue profile enrichment. business-create
// -unit seeds the venue from Google Places, then hands it to this agent, which
// runs the Atlas pipeline as an ordered TIER workflow — tasks within a tier run
// in parallel, tiers run in sequence — ending in a grounded synthesis:
//
//   Tier 1  Google data       Apify Google Maps → reviews, ratings, photos.
//   Tier 2  SERP synthesis     Agent X (Perplexity) → SHORT web-grounded editorial
//                             color (vibe, reputation, signature dishes, press).
//                             SOFT signal; feeds Agent Y context + final synthesis.
//   Tier 3  Link discovery     Agent Y → every missing channel link in one batch;
//                             Firecrawl + Perplexity BOTH run (perp NOT a fallback),
//                             then false-positive + false-negative passes.
//   Tier 4  Source + perceive ∥ Apify Instagram · Apify Facebook · Firecrawl site,
//                             then image vision funnel (text-perception leg removed).
//   Tier 5  Heavy scrapes     OpenTable + TripAdvisor contents (when implemented).
//   Final   Synthesis (T0)     Cognition Agent compiles the profile from ALL
//                             gathered material only (no re-search → can't drift):
//                             About + tags + category + selected images → write.
//
// CONFIG: every knob lives in app_settings, read at run time (the DB is the
// single source of truth). Every source is best-effort + independent; whatever
// fails degrades to null.
//
// Agent contract: verify_jwt=false; requireInternalCaller gates the service-role
// bearer. Invoked by business-create-unit (on create) and admin-enrich-place
// (re-run). Writes the venue row + enrichment_sources.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller, requireInternalCaller } from "../_shared/internal.ts";
import { instagramHandleFromUrl } from "../_shared/apify.ts";
import {
  discoverEmailPerplexity,
  discoverPhonePerplexity,
  fbSlugCandidate,
  resolveChannels,
} from "../_shared/atlas-channel-discovery.ts";
import {
  loadAtlasConfig,
  type MediaAssetPayload,
  PHOTO_CEILING,
} from "../_shared/atlas-config.ts";
import { gatherGoogleMaps } from "../_shared/atlas-google.ts";
import { gatherSerpSummary } from "../_shared/atlas-serp.ts";
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
      "name, address, city, category, instagram_url, facebook_url, website_url, opentable_url, uber_eats_url, tiktok_url, tripadvisor_url, yelp_url, phone, email, google_place_id, google_stars_overall, google_review_count, editorial_summary, photos",
    )
    .eq("id", venueId)
    .maybeSingle();
  if (!row) return json({ ok: false, error: "Venue not found" }, 404);

  // ADEA lifecycle: flip to 'running' the moment we accept the work, so a
  // concurrent consumer read (RLS-gated on 'ready') and the owner both see the
  // in-flight state. 'ready' lands atomically in the final update below; the
  // caller marks 'failed' if this invocation errors.
  await admin.from("venues").update({ adea_status: "running" }).eq("id", venueId);

  // Admin config (app_settings) — read at run time; callers don't pass overrides.
  const cfg = await loadAtlasConfig(admin);

  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_KEY");
  const APIFY_KEY = Deno.env.get("APIFY_KEY");
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_KEY");

  const sources: Record<string, unknown> = {};
  const update: Record<string, unknown> = { enriched_at: new Date().toISOString() };

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
  let resolvedTikTok = strOrNull(row.tiktok_url);
  let resolvedTripAdvisor = strOrNull(row.tripadvisor_url);
  let resolvedYelp = strOrNull(row.yelp_url);
  // Phone is NOT a URL — handled outside the channel discovery pool. Mesita seed
  // (the venues.phone column from create) is the first source; Agent Y has a
  // last-resort Perplexity leg below when it's still empty.
  let resolvedPhone = strOrNull(row.phone);
  // Email is NOT a URL either — Mesita seed (venues.email) first; Agent Y has a
  // last-resort Perplexity leg below when it's still empty.
  let resolvedEmail = strOrNull(row.email);

  // Tier 3 — all channel links resolved in one Link Discovery Agent (Agent Y) pass.
  const needsDiscovery =
    cfg.linkDiscoveryLayer &&
    (!!FIRECRAWL_KEY || !!PERPLEXITY_KEY) &&
    (!resolvedInstagram ||
      !resolvedFacebook ||
      !resolvedWebsite ||
      !resolvedOpenTable ||
      !resolvedUberEats ||
      !resolvedTikTok ||
      !resolvedTripAdvisor ||
      !resolvedYelp ||
      !resolvedPhone ||
      !resolvedEmail);
  const runDiscovery = needsDiscovery;

  const runReviews = cfg.googleLayer && !!APIFY_KEY && !!placeId;

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

  // ── Tier 2 — SERP synthesis (Agent X; soft web-grounded color) ───────────────
  // Runs AFTER Google, BEFORE discovery. The summary is SOFT context only: it
  // grounds Agent Y's discovery prompts and the final Cognition synthesis, but
  // is never an authoritative source of facts/ratings/prices.
  let serpSummary: string | null = null;
  if (cfg.serpLayer && !!PERPLEXITY_KEY) {
    const serp = await gatherSerpSummary({
      perplexityKey: PERPLEXITY_KEY!,
      name,
      locationLine,
      category,
    });
    serpSummary = serp.summary;
    sources.serp = serp.diag;
  }

  // ── Tier 3 — Link discovery (Agent Y; all channels in one pass) ──────────────────
  if (runDiscovery) {
    const found = await resolveChannels({
      firecrawlKey: FIRECRAWL_KEY,
      perplexityKey: PERPLEXITY_KEY,
      name,
      city: (row.city as string | null) ?? null,
      locationLine,
      category,
      serpContext: serpSummary ?? undefined,
      resolveReservationDelivery: true,
      resolveNicheSocial: true,
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

    // Agent Y last-resort PHONE leg: phone isn't a URL, so it rides outside the
    // channel pool. Only when still empty (Mesita seed missed, Google exposed
    // none) and a Perplexity key is present. Returns a normalised number or null.
    let phoneVia: string | null = null;
    if (!resolvedPhone && PERPLEXITY_KEY) {
      const phone = await discoverPhonePerplexity(
        PERPLEXITY_KEY,
        name,
        locationLine,
        category,
        { website: resolvedWebsite, serpContext: serpSummary ?? undefined },
      );
      if (phone) {
        resolvedPhone = phone;
        phoneVia = "perplexity";
      }
    }
    // Agent Y last-resort EMAIL leg — same shape as phone: only when still empty.
    let emailVia: string | null = null;
    if (!resolvedEmail && PERPLEXITY_KEY) {
      const email = await discoverEmailPerplexity(
        PERPLEXITY_KEY,
        name,
        locationLine,
        category,
        { website: resolvedWebsite, serpContext: serpSummary ?? undefined },
      );
      if (email) {
        resolvedEmail = email;
        emailVia = "perplexity";
      }
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
      tiktok: !!resolvedTikTok,
      tripadvisor: !!resolvedTripAdvisor,
      yelp: !!resolvedYelp,
      phone: !!resolvedPhone,
      phone_via: phoneVia,
      email: !!resolvedEmail,
      email_via: emailVia,
    };
  }

  // Persist newly resolved channels. instagram_url is deliberately NOT persisted
  // here — for a generic name the searched candidate may be a different same-
  // named account, so it persists only AFTER the IG scrape verifies it (Tier 4).
  if (resolvedFacebook && resolvedFacebook !== row.facebook_url) update.facebook_url = resolvedFacebook;
  if (resolvedWebsite && resolvedWebsite !== row.website_url) update.website_url = resolvedWebsite;
  // OpenTable/Uber Eats + niche socials are host + shape-validated links (no
  // per-venue identity check the way Instagram needs), so they persist straight
  // away.
  if (resolvedOpenTable && resolvedOpenTable !== row.opentable_url) update.opentable_url = resolvedOpenTable;
  if (resolvedUberEats && resolvedUberEats !== row.uber_eats_url) update.uber_eats_url = resolvedUberEats;
  if (resolvedTikTok && resolvedTikTok !== row.tiktok_url) update.tiktok_url = resolvedTikTok;
  if (resolvedTripAdvisor && resolvedTripAdvisor !== row.tripadvisor_url) update.tripadvisor_url = resolvedTripAdvisor;
  if (resolvedYelp && resolvedYelp !== row.yelp_url) update.yelp_url = resolvedYelp;
  // Phone (Mesita seed or Agent Y's last-resort lookup); persist when changed.
  if (resolvedPhone && resolvedPhone !== row.phone) update.phone = resolvedPhone;
  // Email — same treatment as phone.
  if (resolvedEmail && resolvedEmail !== row.email) update.email = resolvedEmail;

  const igHandle = instagramHandleFromUrl(resolvedInstagram);
  const fbHandleCandidate = fbSlugCandidate(resolvedFacebook);

  // ── Tier 4 — Source gather + perception (parallel; depends on Tier 3 links) ──
  // Run IG whenever we have ANY way to reach a candidate (resolved handle, the
  // FB slug reused as a handle, or a Perplexity lookup) — every candidate is
  // verify-gated, so widening the gate never attaches a wrong account.
  const canDiscoverIg = !!igHandle || !!fbHandleCandidate || !!PERPLEXITY_KEY;
  const runInstagram =
    cfg.sourceGatherLayer && !!APIFY_KEY && canDiscoverIg;
  const runWebsite =
    cfg.sourceGatherLayer && !!FIRECRAWL_KEY && !!resolvedWebsite;
  const maxVisionImages = cfg.visionEnabled
    ? cfg.analyzeGoogleImages + cfg.analyzeWebsiteImages + cfg.analyzeInstagramImages
    : 0;
  const runVision =
    cfg.perceptionLayer && cfg.visionEnabled && !!OPENAI_KEY && maxVisionImages > 0;
  const runFacebook =
    cfg.sourceGatherLayer && !!APIFY_KEY && !!resolvedFacebook;

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

  // ── Tier 4 — Image perception (vision funnel; text-perception leg removed) ────────────
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

  // ── Final (T0) — grounded synthesis (Cognition Agent) + category + persist ──
  // Compiles the profile from ALL gathered material with NO re-search: the About
  // narrative + structured details, the inferred category (below), and the final
  // selected images (already chosen by the image funnel above, persisted into
  // update.photos). The Agent X SERP summary rides along as SOFT context only.
  if (!OPENAI_KEY) return json({ ok: false, error: "OPENAI_KEY not configured" }, 500);
  const synthesisModel = synthesisModelFor(cfg.synthesisQuality);
  const { parsed, diag } = await synthesizeProfile({
    openaiKey: OPENAI_KEY,
    model: synthesisModel,
    name,
    locationLine,
    category,
    igBio,
    googleReviewsText,
    siteMarkdown,
    serpSummary,
  });
  sources.synthesis = diag;
  if (parsed) applyProfileToUpdate(update, parsed);

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

  update.enrichment_sources = sources;
  // Land 'ready' atomically with the enrichment write so consumers (RLS) only
  // ever see a fully-enriched venue, never a half-written one.
  update.adea_status = "ready";

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
