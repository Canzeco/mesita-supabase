// Supabase Edge Function — atlas-enrich-profile (artificial caller / agent)
//
// Atlas is THE caller/orchestrator for venue profile enrichment. The natural
// caller (business-create-unit) seeds the venue from Google Places, then hands
// it to this agent, which runs the full Atlas pipeline end to end:
//
//   ① SOURCES (tier-gated)   Firecrawl Search + website footer (primary) →
//                            Perplexity (fallback only) → Apify (Google Maps
//                            reviews+photos, Instagram, Facebook) → Firecrawl
//                            website. Google/Mesita = spine (always); the
//                            social/website layer is gated by tier ≥ 2.
//   ② IMAGE FUNNEL           gather per source → SAVE (pre-select, per-source
//                            caps, ≤50 total) → ANALYZE (vision describes each)
//                            → SORT (text model ranks by the experience rubric)
//                            → write the ordered photo set.
//   ③ SYNTHESIS              OpenAI "Research Backbone" — reads ONLY the gathered
//                            material (no web → can't drift) into the canonical
//                            profile JSON. Model from the 'synthesis quality' param.
//   ④ COST CAP               stop spending once the per-run USD cap is hit.
//
// CONFIG: every knob lives in app_settings and is read at run time (the DB is
// the single source of truth; callers don't pass overrides). Every source is
// best-effort and independent; whatever fails degrades to null.
//
// Agent contract: verify_jwt=false; requireInternalCaller gates the
// service-role bearer. Invoked by business-create-unit (on create) and
// admin-enrich-venue (re-run). Writes the venue row + enrichment_sources.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller, requireInternalCaller } from "../_shared/internal.ts";
import {
  APIFY_ACTORS,
  instagramHandleFromUrl,
  runApifyActor,
} from "../_shared/apify.ts";
import { firecrawlScrape, firecrawlSearch } from "../_shared/firecrawl.ts";
import {
  canonicaliseUrl,
  domainOf,
  facebookPageFromUrl,
  pickChannel,
  pickFacebook,
  pickInstagram,
  pickWebsite,
  validHost,
} from "../_shared/channels.ts";
import { fetchVenueCategories, inferVenueCategory } from "../_shared/categories.ts";
import {
  extractImagesFromHtml,
  pickInternalPages,
  rankWebsiteImagesByRelevance,
  textSortImages,
  visionDescribe,
  type WebImage,
} from "../_shared/atlas-image-funnel.ts";
import { dedup, humanizeCategorySlug, numOf, safeParseJson } from "../_shared/parse-utils.ts";
import {
  fbSlugCandidate,
  igProfileMatchesVenue,
  isDeadIgStub,
  discoverChannelsPerplexity,
  resolveChannels,
} from "../_shared/atlas-channel-discovery.ts";

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
// sonar-pro searches harder than base sonar (which returns null too often on
// venues whose socials clearly exist). Perplexity is the FALLBACK candidate
// source — Firecrawl Search runs first.
const PERPLEXITY_MODEL = "sonar-pro";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Vision + sort always run on the cheap multimodal model — image work doesn't
// need the synthesis-quality tier (which governs only the profile text model).
const VISION_MODEL = "gpt-4o-mini";

// Synthesis model by the admin 'synthesis quality' param. Synthesis reads only
// the gathered source material (no web) — that's why it's OpenAI, not Perplexity
// (which would re-search and drift). GPT-5.x not yet on the API, so 'high' maps
// to the best available today.
const QUALITY_MODEL: Record<string, string> = {
  economy: "gpt-4o-mini",
  standard: "gpt-4o",
  high: "gpt-4o",
};

// Source steps beyond the Google/Mesita spine (Instagram, Facebook, Website,
// SERP) are all tier 2 in the Atlas catalog, so the whole social/website/SERP
// layer is gated by ceiling >= 2.
const SOCIAL_LAYER_TIER = 2;

// OpenTable (reservations) + UberEats (delivery) link resolution is tier 3 in
// the Atlas catalog, so it's gated by ceiling >= 3.
const RESERVATION_DELIVERY_TIER = 3;

// Hard ceiling on photos persisted to the venue, regardless of per-source caps.
// Safety ceiling on the gathered candidate pool before save (the real,
// source-independent save cap is atlas_save_total_images, applied at the end).
const PHOTO_CEILING = 50;

// Rough per-call cost estimates (USD). Approximate but enough to make the
// per-run cap meaningful — it's a safety valve, not billing.
const COST = {
  compass: 0.05, // Apify Google Maps (reviews + images)
  instagram: 0.02, // Apify IG profile scraper
  // Identity verification of the IG candidate: the LLM judge plus, worst case,
  // a Perplexity fallback + a second IG scrape. Bundled into the IG reservation.
  instagramVerify: 0.04,
  facebook: 0.02, // Apify FB pages scraper
  firecrawl: 0.01, // Firecrawl scrape
  perplexity: 0.01, // Perplexity sonar / Serper
  synthesisEconomy: 0.005, // gpt-4o-mini synthesis
  synthesisStandard: 0.03, // gpt-4o synthesis
  visionPerImage: 0.002, // gpt-4o-mini vision, one image (detail:low)
  sort: 0.003, // gpt-4o-mini text sort
} as const;

type Body = { venue_id?: string };

// Atlas About target: a full public narrative, not a blurb. ~7 chars/word
// (word + space) gives a predictable synthesis budget.
const ATLAS_DESCRIPTION_TARGET_WORDS = 1000;
const ATLAS_DESCRIPTION_MAX = ATLAS_DESCRIPTION_TARGET_WORDS * 7;

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    zone: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    established_year: { type: ["integer", "null"] },
    executive_chef: { type: ["string", "null"] },
    editorial_summary: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    details: {
      type: "object",
      properties: {
        dining_style: { type: ["string", "null"] },
        dress_code: { type: ["string", "null"] },
        service_options: { type: "array", items: { type: "string" } },
        reservations: { type: ["string", "null"] },
        payment_methods: { type: "array", items: { type: "string" } },
        parking: { type: ["string", "null"] },
        amenities: { type: "array", items: { type: "string" } },
        accessibility: { type: "array", items: { type: "string" } },
        dietary_options: { type: "array", items: { type: "string" } },
        good_for: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        kid_friendly: { type: ["boolean", "null"] },
        pet_friendly: { type: ["boolean", "null"] },
      },
    },
    products: {
      type: "object",
      properties: {
        menu: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    price: { type: ["string", "null"] },
                    description: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
        },
      },
    },
    popular_times: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          range: { type: "string" },
        },
      },
    },
  },
} as const;


type ProfileResult = {
  zone?: string | null;
  city?: string | null;
  established_year?: number | null;
  executive_chef?: string | null;
  editorial_summary?: string | null;
  description?: string | null;
  details?: Record<string, unknown> | null;
  products?: { menu?: unknown[] | null } | null;
  menus?: unknown[] | null;
  popular_times?: unknown[] | null;
};

// One photo candidate + which source it came from (drives the per-source
// analyze caps in the funnel).
type Img = { url: string; source: "google" | "website" | "instagram" };
type MediaAssetPayload = {
  source: Img["source"];
  source_url: string;
  likes_count?: number | null;
  caption?: string | null;
  analysis?: string | null;
  source_metadata?: Record<string, unknown> | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const venueId = (body.venue_id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "venue_id is required" }, 400);

  const admin = adminClient(envRes.env);
  const { data: row } = await admin
    .from("venues")
    .select(
      "name, address, city, category, instagram_url, facebook_url, website_url, google_place_id, google_stars_overall, google_review_count, editorial_summary, photos",
    )
    .eq("id", venueId)
    .maybeSingle();
  if (!row) return json({ ok: false, error: "Venue not found" }, 404);

  // ── Admin config (app_settings) ──────────────────────────────────────────
  // The Atlas admin console tunes these. The agent reads them at run time;
  // callers don't pass overrides (the DB is the single source of truth).
  const { data: cfg } = await admin
    .from("app_settings")
    .select(
      [
        "atlas_source_tier_ceiling",
        "atlas_synthesis_quality",
        "atlas_gather_google_images",
        "atlas_gather_website_images",
        "atlas_gather_instagram_posts",
        "atlas_save_total_images",
        "atlas_image_vision_enabled",
        "atlas_analyze_google_images",
        "atlas_analyze_website_images",
        "atlas_analyze_instagram_images",
        "atlas_image_analysis_prompt",
        "atlas_image_sorting_prompt",
        "atlas_per_run_cost_cap_usd",
        "atlas_website_crawl_max_pages",
      ].join(", "),
    )
    .eq("id", 1)
    .maybeSingle();

  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const tierCeiling = num(cfg?.atlas_source_tier_ceiling, 3);
  const synthesisQuality =
    (cfg?.atlas_synthesis_quality as string | undefined) ?? "economy";
  // GATHER caps — how many to PULL per source before anything else.
  const gatherGoogleImages = num(cfg?.atlas_gather_google_images, 10);
  const gatherWebsiteImages = num(cfg?.atlas_gather_website_images, 10);
  const gatherInstagramPosts = num(cfg?.atlas_gather_instagram_posts, 10);
  // How many website pages to crawl for images (homepage + internal links).
  const websiteCrawlMaxPages = Math.max(1, num(cfg?.atlas_website_crawl_max_pages, 5));
  // SAVE cap — final count persisted to the venue, SOURCE-INDEPENDENT, applied
  // after analyze + rubric sort.
  const saveTotalImages = num(cfg?.atlas_save_total_images, 20);
  const visionEnabled = (cfg?.atlas_image_vision_enabled as boolean) ?? true;
  // ANALYZE caps — how many of the gathered images per source go to vision.
  const analyzeGoogleImages = num(cfg?.atlas_analyze_google_images, 10);
  const analyzeWebsiteImages = num(cfg?.atlas_analyze_website_images, 10);
  const analyzeInstagramImages = num(cfg?.atlas_analyze_instagram_images, 10);
  const imageAnalysisPrompt =
    (cfg?.atlas_image_analysis_prompt as string | undefined)?.trim() ||
    "Describe this venue photo: subject (ambiance / interior / exterior / food / people / detail), visual quality, lighting, and whether it is representative and appealing. Be concise and factual.";
  const imageSortingPrompt =
    (cfg?.atlas_image_sorting_prompt as string | undefined)?.trim() ||
    "Rank these venue photos best to worst for a should-we-go-tonight decision. We sell EXPERIENCES: weight beautiful place / ambiance / vibe shots EQUALLY with food. Favor visual quality, representativeness, and a balanced mix. Drop duplicates, blurry, dark, or text-heavy images.";
  const costCapUsd = num(Number(cfg?.atlas_per_run_cost_cap_usd), 1.0) || 1.0;
  // Whole social/website layer runs only when the ceiling allows tier 2.
  const socialLayer = tierCeiling >= SOCIAL_LAYER_TIER;
  // OpenTable + UberEats link resolution runs only when the ceiling allows tier 3.
  const reservationDeliveryLayer = tierCeiling >= RESERVATION_DELIVERY_TIER;

  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_KEY");
  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
  const APIFY_KEY = Deno.env.get("APIFY_KEY");
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_KEY");

  const sources: Record<string, unknown> = {};
  const update: Record<string, unknown> = { enriched_at: new Date().toISOString() };

  // ── Cost cap ────────────────────────────────────────────────────────────────
  // Reserve budget BEFORE running each step, in priority order. A step that
  // doesn't fit the remaining budget is disabled (skipped) — so the run never
  // exceeds the per-run USD cap.
  let plannedUsd = 0;
  const cost: Record<string, number> = {};
  const reserve = (label: string, c: number): boolean => {
    if (plannedUsd + c > costCapUsd) return false;
    plannedUsd += c;
    cost[label] = c;
    return true;
  };

  // ── Channel discovery ────────────────────────────────────────────────────
  // The columns may already carry socials harvested from the venue's website
  // at create time. For any channel still missing, ask Perplexity to resolve
  // the canonical URL from search, then host-validate it before trusting it.
  let resolvedInstagram =
    typeof row.instagram_url === "string" && row.instagram_url
      ? row.instagram_url
      : null;
  let resolvedFacebook =
    typeof row.facebook_url === "string" && row.facebook_url
      ? row.facebook_url
      : null;
  let resolvedWebsite =
    typeof row.website_url === "string" && row.website_url
      ? row.website_url
      : null;
  let resolvedOpenTable =
    typeof row.opentable_url === "string" && row.opentable_url
      ? row.opentable_url
      : null;
  let resolvedUberEats =
    typeof row.uber_eats_url === "string" && row.uber_eats_url
      ? row.uber_eats_url
      : null;

  // Synthesis is core — reserve it first so the profile always gets written.
  const synthCost =
    synthesisQuality === "economy"
      ? COST.synthesisEconomy
      : COST.synthesisStandard;
  const runSynthesis = !!OPENAI_KEY && reserve("synthesis", synthCost);

  // Run discovery whenever a channel is still missing.
  const needsDiscovery =
    socialLayer &&
    (!!FIRECRAWL_KEY || !!PERPLEXITY_KEY) &&
    (!resolvedInstagram ||
      !resolvedFacebook ||
      !resolvedWebsite ||
      (reservationDeliveryLayer && (!resolvedOpenTable || !resolvedUberEats)));
  const runDiscovery = needsDiscovery && reserve("discovery", COST.perplexity);

  if (runDiscovery) {
    // Channel links resolve in the Atlas order: whatever Google already gave
    // us (passed in via `have`) → Firecrawl Search on "<name> <city> <network>"
    // → Perplexity as the last-resort fallback. Each result is host-validated
    // and normalised to the canonical profile URL before we trust it.
    const found = await resolveChannels({
      firecrawlKey: FIRECRAWL_KEY,
      perplexityKey: PERPLEXITY_KEY,
      name: row.name as string,
      city: (row.city as string | null) ?? null,
      locationLine: [row.address, row.city].filter(Boolean).join(", "),
      category: (row.category as string | null) ?? null,
      resolveReservationDelivery: reservationDeliveryLayer,
      have: {
        instagram: resolvedInstagram,
        facebook: resolvedFacebook,
        website: resolvedWebsite,
        opentable: resolvedOpenTable,
        uberEats: resolvedUberEats,
      },
    });
    if (!resolvedInstagram && found.instagram_url) resolvedInstagram = found.instagram_url;
    if (!resolvedFacebook && found.facebook_url) resolvedFacebook = found.facebook_url;
    if (!resolvedWebsite && found.website_url) resolvedWebsite = found.website_url;
    if (reservationDeliveryLayer) {
      if (!resolvedOpenTable && found.opentable_url) resolvedOpenTable = found.opentable_url;
      if (!resolvedUberEats && found.uber_eats_url) resolvedUberEats = found.uber_eats_url;
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
    };
  }

  // Persist any newly resolved channel so future reads + re-runs have them.
  // NOTE: instagram_url is deliberately NOT persisted here — for a generic
  // name the searched candidate may be a different same-named account, so we
  // only persist it AFTER the IG scrape verifies it belongs to this venue
  // (see the Instagram gather step below).
  if (resolvedFacebook && resolvedFacebook !== row.facebook_url) {
    update.facebook_url = resolvedFacebook;
  }
  if (resolvedWebsite && resolvedWebsite !== row.website_url) {
    update.website_url = resolvedWebsite;
  }
  // OpenTable + UberEats are host-validated directory links (no per-venue
  // identity check the way Instagram needs), so they persist straight away.
  if (resolvedOpenTable && resolvedOpenTable !== row.opentable_url) {
    update.opentable_url = resolvedOpenTable;
  }
  if (resolvedUberEats && resolvedUberEats !== row.uber_eats_url) {
    update.uber_eats_url = resolvedUberEats;
  }

  const igHandle = instagramHandleFromUrl(resolvedInstagram);
  // A Facebook page slug is a strong Instagram-handle candidate: venues almost
  // always reuse the same handle across networks (fb.com/Stranasanpedro ⇒ try
  // instagram.com/Stranasanpedro). profile.php?id= pages and anything with
  // non-handle characters are rejected so we never feed Apify junk.
  const fbHandleCandidate = fbSlugCandidate(resolvedFacebook);
  const placeId =
    typeof row.google_place_id === "string" ? row.google_place_id : null;

  // ── Reserve budget for the gather steps (priority: reviews → IG → website →
  //    vision → FB). Anything that doesn't fit is skipped. ───────────────────
  const runReviews =
    !!APIFY_KEY && !!placeId && reserve("apify_google", COST.compass);
  // Run IG whenever we have ANY way to reach a candidate — not only a handle
  // Google/Firecrawl already resolved. A no-website venue (e.g. a nightclub)
  // often isn't surfaced by Firecrawl's IG search, but its Facebook slug or a
  // Perplexity lookup still gets us there. Every candidate is verify-gated
  // below, so widening the gate never attaches a wrong account.
  const canDiscoverIg = !!igHandle || !!fbHandleCandidate || !!PERPLEXITY_KEY;
  const runInstagram =
    socialLayer && !!APIFY_KEY && canDiscoverIg &&
    reserve("apify_instagram", COST.instagram + COST.instagramVerify);
  const runWebsite =
    socialLayer && !!FIRECRAWL_KEY && !!resolvedWebsite &&
    reserve("firecrawl", COST.firecrawl * websiteCrawlMaxPages + COST.sort);
  const maxVisionImages = visionEnabled
    ? analyzeGoogleImages + analyzeWebsiteImages + analyzeInstagramImages
    : 0;
  const runVision =
    visionEnabled &&
    !!OPENAI_KEY &&
    maxVisionImages > 0 &&
    reserve("vision", maxVisionImages * COST.visionPerImage + COST.sort);
  const runFacebook =
    socialLayer && !!APIFY_KEY && !!resolvedFacebook && reserve("apify_facebook", COST.facebook);

  // ── Gather (concurrent) ──────────────────────────────────────────────────
  // Run the live fetches that weren't budget-capped.
  let igBio = "";
  let igFollowers: number | null = null;
  let fbFollowers: number | null = null;
  let fbRating: number | null = null;
  let siteMarkdown = "";
  let googleReviewsText = "";
  let reviews: Record<string, unknown>[] = [];
  let reviewCount: number | null = null;
  let googleImages: string[] = [];
  let websiteImages: string[] = [];
  let instagramImages: string[] = [];
  const instagramAssetMeta = new Map<
    string,
    { likes_count: number | null; caption: string | null; source_metadata: Record<string, unknown> }
  >();
  const websiteAssetMeta = new Map<string, Record<string, unknown>>();
  // Only set once the scraped IG profile verifies as THIS venue's account.
  let verifiedInstagramUrl: string | null = null;

  await Promise.all([
    // Apify Google Maps → ALL reviews (Places caps at ~5) + venue PHOTOS in one
    // run. Spine-tier. maxImages drives the Google image bucket; reviews capped
    // at 100 for the EF wall-clock (a safety bound, not a product cap).
    (async () => {
      if (!runReviews) return;
      const items = await runApifyActor<Record<string, unknown>>(
        APIFY_ACTORS.googleMaps,
        {
          placeIds: [placeId],
          maxReviews: 100,
          maxImages: Math.max(0, gatherGoogleImages),
          language: "es",
          reviewsSort: "newest",
          reviewsPersonalData: true,
        },
        APIFY_KEY!,
        60000,
      );
      const p = items?.[0] as Record<string, unknown> | undefined;
      const raw = Array.isArray(p?.reviews) ? (p!.reviews as Record<string, unknown>[]) : [];
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
      reviews = raw
        .slice(0, 100)
        .map((r) => ({
          author: str(r.name) ?? str(r.reviewerName),
          rating: numOf(r.stars) ?? numOf(r.rating) ?? numOf(r.starRating),
          text: str(r.text) ?? str(r.textTranslated) ?? str(r.reviewText),
          published: str(r.publishedAtDate) ?? str(r.publishAt) ?? str(r.publishedAt),
        }))
        .filter((r) => r.text || r.rating != null);
      reviewCount = numOf(p?.reviewsCount);
      const withText = reviews.filter((r) => r.text);
      googleReviewsText = withText
        .slice(0, 12)
        .map((r) => `(${r.rating ?? "?"}★) ${r.text}`)
        .join("\n")
        .slice(0, 3000);
      // Google photos straight from the same run (durable lh3 URLs).
      const imgs = Array.isArray(p?.imageUrls) ? (p!.imageUrls as unknown[]) : [];
      googleImages = imgs
        .filter((u): u is string => typeof u === "string" && u.startsWith("http"))
        .slice(0, gatherGoogleImages);
      sources.apify_google_reviews = {
        ok: reviews.length > 0,
        count: reviews.length,
        with_text: withText.length,
        images: googleImages.length,
        sample_keys: raw[0] ? Object.keys(raw[0]).slice(0, 25) : [],
      };
    })(),
    // Apify → Instagram: followers + bio + post IMAGES (top by likes).
    // IDENTITY-CHECKED but GENEROUS: we scrape the candidate and confirm it's
    // this venue's OR its brand's account (website-domain match, FB-slug
    // agreement, brand-name match, else a true-biased LLM judge) — a franchise's
    // single brand account is a valid result. We try candidates in order — the
    // Firecrawl/Google handle, then the Facebook slug reused as a handle, then a
    // Perplexity-resolved handle — and keep the first that passes. Only a
    // genuinely dead/nonexistent handle is dropped: a missing IG is the worse
    // miss, so when in doubt we attach the brand account rather than nothing.
    (async () => {
      if (!runInstagram) return;
      const venueCtx = {
        name: row.name as string,
        locationLine: [row.address, row.city].filter(Boolean).join(", "),
        website: resolvedWebsite,
        facebook: resolvedFacebook,
        category: (row.category as string | null) ?? null,
      };
      const tried = new Set<string>();
      // corroborateFb=true means the candidate was found INDEPENDENTLY (Firecrawl
      // /Google/Perplexity), so agreement with the Facebook slug is real
      // corroboration. The candidate we DERIVE from the Facebook slug can't use
      // FB to vouch for itself (circular), so that one must clear the website
      // match or the LLM judge instead.
      const attempt = async (handle: string | null, corroborateFb = true) => {
        if (!handle || tried.has(handle.toLowerCase())) return null;
        tried.add(handle.toLowerCase());
        const items = await runApifyActor<Record<string, unknown>>(
          APIFY_ACTORS.instagramProfile,
          { usernames: [handle] },
          APIFY_KEY!,
        );
        const p = items?.[0];
        // For a NONEXISTENT handle the scraper still returns a non-null object —
        // the username echoed back with every data field null/empty. Treat that
        // empty stub as not-found so a dead handle (e.g. a guessed FB-slug that
        // isn't a real IG account) never reaches the identity judge and gets
        // falsely "verified". A real venue account always has at least followers.
        if (!p || isDeadIgStub(p)) return null;
        const ok = await igProfileMatchesVenue(p, venueCtx, OPENAI_KEY, corroborateFb);
        return { handle, p, ok };
      };

      // 1) The Firecrawl/Google candidate (independent → FB corroboration ok).
      let chosen = await attempt(igHandle);
      // 2) The Facebook slug reused as an IG handle. Derived from FB, so it
      //    can't corroborate via FB — it leans on the website match / judge.
      if (!chosen?.ok) {
        const alt = await attempt(fbHandleCandidate, false);
        chosen = alt?.ok ? alt : (chosen ?? alt);
      }
      // 3) Last resort: ask Perplexity for the right account + verify it.
      if (!chosen?.ok && PERPLEXITY_KEY) {
        const pp = await discoverChannelsPerplexity(
          PERPLEXITY_KEY,
          venueCtx.name,
          venueCtx.locationLine,
          venueCtx.category,
        );
        const alt = await attempt(instagramHandleFromUrl(pp?.instagram_url ?? null));
        chosen = alt?.ok ? alt : (chosen ?? alt);
      }

      if (chosen?.ok) {
        const p = chosen.p;
        verifiedInstagramUrl = `https://www.instagram.com/${chosen.handle}`;
        igFollowers = numOf(p.followersCount);
        if (typeof p.biography === "string") igBio = p.biography;
        const posts = Array.isArray(p.latestPosts)
          ? (p.latestPosts as Record<string, unknown>[])
          : [];
        const orderedPosts = posts
          // Videos are kept: their `displayUrl` is the cover frame, so we
          // analyze it as a photo rather than dropping the post.
          .filter(
            (po) =>
              typeof po.displayUrl === "string" &&
              (po.displayUrl as string).startsWith("http"),
          )
          .sort((a, b) => (numOf(b.likesCount) ?? 0) - (numOf(a.likesCount) ?? 0))
          .slice(0, gatherInstagramPosts);
        instagramImages = orderedPosts.map((po) => po.displayUrl as string);
        for (const po of orderedPosts) {
          const url = po.displayUrl as string;
          instagramAssetMeta.set(url, {
            likes_count: numOf(po.likesCount),
            caption: typeof po.caption === "string" ? po.caption : null,
            source_metadata: {
              comments_count: numOf(po.commentsCount),
              is_video: !!po.isVideo,
              shortcode: typeof po.shortCode === "string" ? po.shortCode : null,
              timestamp:
                typeof po.timestamp === "string" || typeof po.timestamp === "number"
                  ? po.timestamp
                  : null,
            },
          });
        }
        sources.apify_instagram = {
          handle: chosen.handle,
          ok: true,
          verified: true,
          posts: posts.length,
          images: instagramImages.length,
        };
      } else {
        // No account passed identity verification — attach nothing.
        sources.apify_instagram = {
          ok: false,
          reason: chosen ? "unverified" : "not_found",
          candidate: igHandle ?? fbHandleCandidate,
          tried: [...tried],
        };
      }
    })(),
    // Apify → Facebook (followers + rating).
    (async () => {
      if (!runFacebook) return;
      const items = await runApifyActor<Record<string, unknown>>(
        APIFY_ACTORS.facebookPages,
        { startUrls: [{ url: resolvedFacebook }] },
        APIFY_KEY!,
      );
      const p = items?.[0];
      if (p) {
        fbFollowers = numOf(p.followers) ?? numOf(p.likes);
        const rating = numOf(p.rating) ?? numOf(p.overallStarRating);
        if (rating != null && rating >= 0 && rating <= 5) fbRating = rating;
        sources.apify_facebook = { ok: true };
      } else {
        sources.apify_facebook = { ok: false };
      }
    })(),
    // Firecrawl → website markdown (menu grounding) + website IMAGES.
    // Crawl up to N pages (homepage + internal links), collect EVERY <img>
    // with its alt/dimensions/page context, then ask an LLM to rank them
    // hero-first (square dimensions prioritised; logos/icons/sprites dropped),
    // and keep the gather cap.
    (async () => {
      if (!runWebsite) return;
      try {
        const home = await firecrawlScrape(FIRECRAWL_KEY, resolvedWebsite!, {
          formats: ["markdown", "html", "links"],
          onlyMainContent: false,
        });
        if (!home) {
          sources.firecrawl = { ok: false };
          return;
        }
        siteMarkdown = home.markdown.slice(0, 6000);

        const candidates: WebImage[] = [];
        const seen = new Set<string>();
        const collect = (imgs: WebImage[]) => {
          for (const img of imgs) {
            if (!seen.has(img.url) && candidates.length < 60) {
              seen.add(img.url);
              candidates.push(img);
            }
          }
        };
        const og = home.metadata.ogImage;
        if (typeof og === "string") collect([{ url: og, alt: "og:image", page: "home" }]);
        collect(extractImagesFromHtml(home.html ?? "", resolvedWebsite!, "home"));

        // Follow up to (N-1) same-domain internal pages, scraped in parallel.
        const extraPages = pickInternalPages(home.links, resolvedWebsite!, websiteCrawlMaxPages - 1);
        if (extraPages.length > 0) {
          const scrapes = await Promise.all(
            extraPages.map((p) =>
              firecrawlScrape(FIRECRAWL_KEY, p, { formats: ["html"], onlyMainContent: false }),
            ),
          );
          scrapes.forEach((s, i) => {
            if (s) collect(extractImagesFromHtml(s.html ?? "", extraPages[i], `p${i + 1}`));
          });
        }

        const ranked = await rankWebsiteImagesByRelevance(OPENAI_KEY, candidates);
        websiteImages = ranked.slice(0, gatherWebsiteImages);
        for (const c of candidates) {
          websiteAssetMeta.set(c.url, {
            alt: c.alt || null,
            width: c.width ?? null,
            height: c.height ?? null,
            page: c.page,
          });
        }
        sources.firecrawl = {
          ok: !!siteMarkdown,
          pages: 1 + extraPages.length,
          candidates: candidates.length,
          images: websiteImages.length,
        };
      } catch {
        sources.firecrawl = { ok: false };
      }
    })(),
  ]);

  // Persist the numeric source facts.
  if (reviews.length > 0) {
    update.google_reviews = reviews;
    if (reviewCount != null) update.google_review_count = reviewCount;
  }
  if (igFollowers != null) update.instagram_followers_count = igFollowers;
  if (fbFollowers != null) update.facebook_followers = fbFollowers;
  if (fbRating != null) update.facebook_rating = fbRating;
  // Persist instagram_url ONLY if the scrape verified it belongs to this venue.
  if (verifiedInstagramUrl && verifiedInstagramUrl !== row.instagram_url) {
    update.instagram_url = verifiedInstagramUrl;
  }

  // ── Image funnel: build the gathered pool (post metadata-sort) ───────────
  // Each source contributes its gather-capped, metadata-sorted bucket (Google
  // in Google's order, Website by size, Instagram by likes). business-create-
  // unit may have seeded Places photos into row.photos — fold those into the
  // Google bucket so we never lose them, capped at the Google GATHER cap.
  const existingPhotos = Array.isArray(row.photos) ? (row.photos as string[]) : [];
  const googleBucket = dedup([...googleImages, ...existingPhotos]).slice(
    0,
    gatherGoogleImages,
  );
  const saved: Img[] = [];
  const imageAnalysisByUrl = new Map<string, string>();
  const savedSeen = new Set<string>();
  const pushImg = (url: string, source: Img["source"]) => {
    if (!url || savedSeen.has(url) || saved.length >= PHOTO_CEILING) return;
    savedSeen.add(url);
    saved.push({ url, source });
  };
  for (const u of googleBucket) pushImg(u, "google");
  for (const u of websiteImages) pushImg(u, "website");
  for (const u of instagramImages) pushImg(u, "instagram");

  // ── Image funnel: ANALYZE (vision) → SORT (text) → SAVE (top N) ──────────
  // Take the per-source analyze caps off the top of each metadata-sorted
  // bucket, have the vision model DESCRIBE each (image_analysis_prompt), then a
  // text model RANK those descriptions (image_sorting_prompt). The final SAVE
  // cap (saveTotalImages) is SOURCE-INDEPENDENT — keep the best N overall.
  let finalPhotos = saved.map((s) => s.url).slice(0, saveTotalImages);
  let funnelDiag: Record<string, unknown> = {
    gathered: saved.length,
    by_source: {
      google: saved.filter((s) => s.source === "google").length,
      website: saved.filter((s) => s.source === "website").length,
      instagram: saved.filter((s) => s.source === "instagram").length,
    },
    save_cap: saveTotalImages,
    vision: false,
  };
  if (runVision && saved.length > 1) {
    const caps: Record<Img["source"], number> = {
      google: analyzeGoogleImages,
      website: analyzeWebsiteImages,
      instagram: analyzeInstagramImages,
    };
    const used: Record<Img["source"], number> = { google: 0, website: 0, instagram: 0 };
    const toAnalyze: Img[] = [];
    for (const img of saved) {
      if (used[img.source] < caps[img.source]) {
        toAnalyze.push(img);
        used[img.source] += 1;
      }
    }
    if (toAnalyze.length > 0) {
      const descriptions = await visionDescribe(
        OPENAI_KEY!,
        toAnalyze.map((i) => i.url),
        imageAnalysisPrompt,
      );
      let order: number[] | null = null;
      if (descriptions) {
        for (let i = 0; i < descriptions.length; i += 1) {
          const desc = descriptions[i];
          if (desc && toAnalyze[i]?.url) imageAnalysisByUrl.set(toAnalyze[i].url, desc);
        }
        order = await textSortImages(OPENAI_KEY!, descriptions, imageSortingPrompt);
      }
      if (order && order.length > 0) {
        const ranked = order
          .filter((i) => i >= 0 && i < toAnalyze.length)
          .map((i) => toAnalyze[i].url);
        const analyzedSet = new Set(toAnalyze.map((i) => i.url));
        const rest = saved.map((s) => s.url).filter((u) => !analyzedSet.has(u));
        // Rubric-ranked images lead; un-analyzed gathered images follow in
        // metadata order. Then keep only the top N overall (source-independent).
        finalPhotos = dedup([...ranked, ...rest]).slice(0, saveTotalImages);
        funnelDiag = {
          ...funnelDiag,
          vision: true,
          analyzed: toAnalyze.length,
          described: !!descriptions,
          sorted: true,
          saved: finalPhotos.length,
        };
      } else {
        funnelDiag = { ...funnelDiag, vision: true, analyzed: toAnalyze.length, sorted: false };
      }
    }
  }
  if (finalPhotos.length > 0) update.photos = finalPhotos;
  sources.image_funnel = funnelDiag;

  // ── OpenAI: grounded synthesis (Research Backbone) ───────────────────────
  if (!OPENAI_KEY) {
    return json({ ok: false, error: "OPENAI_KEY not configured" }, 500);
  }
  const synthesisModel = QUALITY_MODEL[synthesisQuality] ?? "gpt-4o-mini";
  const locationLine = [row.address, row.city].filter(Boolean).join(", ");
  const grounding = [
    igBio ? `Instagram bio: ${igBio}` : "",
    googleReviewsText ? `Google reviews (sample):\n${googleReviewsText}` : "",
    siteMarkdown ? `Website content (excerpt):\n${siteMarkdown}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const userPrompt =
    `Compile the public profile of the venue "${row.name}"` +
    (locationLine ? ` located at ${locationLine}` : "") +
    (row.category ? ` (category: ${row.category})` : "") +
    `, using ONLY the source material below. Return a single JSON object ` +
    `matching the schema. Build products.menu from website content when ` +
    `present (real dish names + prices only). Write "description" as the ` +
    `public About section for the Place page: a rich, inviting, factual ` +
    `narrative of roughly ${ATLAS_DESCRIPTION_TARGET_WORDS} words (max ` +
    `${ATLAS_DESCRIPTION_MAX} characters). Use short paragraphs. Cover ` +
    `atmosphere, cuisine, signature dishes or experiences, history or ` +
    `neighborhood context, and what makes a visit worthwhile — only when ` +
    `the sources support it. No filler or invented detail. ` +
    `Use null or [] for anything the ` +
    `sources don't support. Never invent ratings, reviewer quotes, prices, or ` +
    `a chef's name.` +
    (grounding ? `\n\n--- SOURCE MATERIAL ---\n${grounding}` : "\n\n(No extra source material was gathered.)");

  const systemContent =
    "You are Mesita's venue-intelligence synthesis agent. Use ONLY the source " +
    "material the user provides — do not browse or use outside knowledge. " +
    "Output a SINGLE valid JSON object (no prose, no markdown fences) matching " +
    "this shape, using null or [] when the sources don't support a field: " +
    JSON.stringify(PROFILE_SCHEMA.properties) +
    " Never invent ratings, reviewer quotes, prices, or a chef's name.";

  let parsed: ProfileResult | null = null;
  if (runSynthesis) {
    try {
      const r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: synthesisModel,
          temperature: 0.2,
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (r.ok) {
        const data = (await r.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        parsed = safeParseProfile(data.choices?.[0]?.message?.content ?? "");
        sources.synthesis = { provider: "openai", model: synthesisModel, ok: !!parsed };
      } else {
        sources.synthesis = {
          provider: "openai",
          model: synthesisModel,
          ok: false,
          status: r.status,
        };
      }
    } catch {
      sources.synthesis = { provider: "openai", model: synthesisModel, ok: false };
    }
  } else {
    sources.synthesis = { ok: false, reason: "cost_cap" };
  }

  if (parsed) {
    if (parsed.zone) update.zone = parsed.zone;
    if (parsed.city) update.city = parsed.city;
    if (typeof parsed.established_year === "number") {
      update.established_year = parsed.established_year;
    }
    if (parsed.executive_chef) update.executive_chef = parsed.executive_chef;
    if (parsed.editorial_summary) {
      update.editorial_summary = parsed.editorial_summary;
    }
    // The place's public About — written at the end of every run. Hard cap at
    // ~1000 words. Only overwrite when synthesis actually produced text.
    if (parsed.description && parsed.description.trim()) {
      update.description = parsed.description.trim().slice(0, ATLAS_DESCRIPTION_MAX);
    }
    if (parsed.details && typeof parsed.details === "object") {
      update.details = parsed.details;
    }
    const productMenu = Array.isArray(parsed.products?.menu)
      ? parsed.products?.menu
      : Array.isArray(parsed.menus)
        ? parsed.menus
        : null;
    if (productMenu && productMenu.length > 0) {
      // Canonical storage: products.menu. Keep menus synced for compatibility.
      update.products = { menu: productMenu };
      update.menus = productMenu;
    }
    if (Array.isArray(parsed.popular_times) && parsed.popular_times.length > 0) {
      update.popular_times = parsed.popular_times;
    }
  }

  // ── Category inference (dynamic, from the live venue_categories table) ───
  // Read the editable vocabulary at run time and let the classifier pick the
  // best-fit slug from it — never hardcoded. Prefers the freshly synthesised
  // editorial summary, falling back to the venue's existing signals + gathered
  // text. Only overwrites venue.category when we get a valid canonical slug.
  const categoryList = await fetchVenueCategories(admin);
  const inferredCategory = await inferVenueCategory(OPENAI_KEY, categoryList, {
    name: row.name as string,
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

  // ── Cost accounting ──────────────────────────────────────────────────────
  sources.cost = {
    cap_usd: costCapUsd,
    estimated_usd: Math.round(plannedUsd * 1000) / 1000,
    breakdown: cost,
  };
  update.enrichment_sources = sources;

  const { error: updErr } = await admin
    .from("venues")
    .update(update)
    .eq("id", venueId);
  if (updErr) {
    return json({ ok: false, error: `venue_update: ${updErr.message}` }, 500);
  }

  // Queue media persistence asynchronously: keep source URLs in the runtime
  // response for speed, then mirror + metadata-save in background.
  const mediaAssets: MediaAssetPayload[] = saved.map((img) => {
    const ig = instagramAssetMeta.get(img.url);
    const web = websiteAssetMeta.get(img.url);
    return {
      source: img.source,
      source_url: img.url,
      likes_count: ig?.likes_count ?? null,
      caption: ig?.caption ?? null,
      analysis: imageAnalysisByUrl.get(img.url) ?? null,
      source_metadata: ig?.source_metadata ?? web ?? null,
    };
  });
  let mediaAsync: Record<string, unknown> = { queued: false, assets: mediaAssets.length };
  if (mediaAssets.length > 0) {
    const mediaRes = await invokeArtificialCaller(
      envRes.env,
      "atlas-enrich-profile",
      "atlas-save-venue-media",
      {
        venue_id: venueId,
        assets: mediaAssets,
        preferred_photo_urls: finalPhotos,
      },
    );
    if (mediaRes.ok) {
      mediaAsync = { queued: true, assets: mediaAssets.length };
    } else {
      mediaAsync = {
        queued: false,
        assets: mediaAssets.length,
        error: mediaRes.error,
        status: mediaRes.status,
      };
    }
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

function safeParseProfile(content: string): ProfileResult | null {
  return safeParseJson(content) as ProfileResult | null;
}
