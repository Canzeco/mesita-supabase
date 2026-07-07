// Enricher pipeline: run-time config + shared types.
//
// Every knob lives in app_settings (columns still named atlas_* for
// historical continuity with the admin console) and is read at run time —
// the DB is the single source of truth; callers never pass overrides.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Vision + sort always run on the cheap multimodal model — image work doesn't
// need the synthesis-quality setting (which governs only the profile text model).
export const VISION_MODEL = "gpt-4o-mini";

// Synthesis model by the admin 'synthesis quality' param. Synthesis reads only
// the gathered source material (no web) — that's why it's OpenAI, not Perplexity
// (which would re-search and drift). GPT-5.x not yet on the API, so 'high' maps
// to the best available today.
export const QUALITY_MODEL: Record<string, string> = {
  economy: "gpt-4o-mini",
  standard: "gpt-4o",
  high: "gpt-4o",
};

// Resolve the per-image vision model from the admin 'Image model' knob
// (same economy/standard/high scale as synthesis).
export function visionModelFor(quality: string): string {
  return QUALITY_MODEL[quality] ?? VISION_MODEL;
}

// ADEA runs ALL steps S0–S6 on every enrichment. There is no admin "source step
// ceiling" any more — each step fires whenever its real prerequisites hold (the
// relevant API key is present AND its required input exists, e.g. a website to
// scrape). The only remaining feature toggle is `visionEnabled` (image vision).

// Hard ceiling on photos persisted to the place, regardless of per-source caps.
// Safety bound on the candidate pool before save (the real, source-independent
// save cap is atlas_save_total_images, applied at the end).
export const PHOTO_CEILING = 50;

// Atlas About target: a full public narrative, not a blurb. ~7 chars/word
// (word + space) gives a predictable synthesis budget.
export const ENRICH_DESCRIPTION_TARGET_WORDS = 1000;
export const ENRICH_DESCRIPTION_MAX = ENRICH_DESCRIPTION_TARGET_WORDS * 7;

// Per-call cost estimates (USD), from each provider's PUBLISHED price list
// (verified 2026-07-07). MIRRORS the admin cost calculator's rate card
// (mesita-web-admin `atlas-config/cost-model.ts`). Documentation only — no EF
// reads this; approximate, not billing. Keep the two in sync.
//
// Sources: Google Maps Platform pricing list (Places API New, first tier) ·
// Apify Store actor pages (pay-per-event) · Firecrawl pricing · Perplexity
// Agent API pricing · OpenAI API pricing.
export const COST = {
  // Google — Places API (New). The S1 field mask requests reviews +
  // editorial/generative/review summaries → billed Enterprise+Atmosphere
  // ($25/1k), NOT Pro ($17/1k).
  googleDetails: 0.025, // Place Details, Enterprise+Atmosphere SKU, $25/1k
  googlePhoto: 0.007, // Place Photo (New) media fetch, $7/1k, per photo (≤10/place)
  googleTimezone: 0.005, // Time Zone API, $5/1k
  // Apify compass/crawler-google-places: $1.50/1k places + $0.20/place details +
  // reviews $0.50/100 (maxReviews:100). ~0.30 typical, ~0.65 at 100 reviews.
  compass: 0.3,
  instagramProfile: 0.0026, // Apify instagram-profile-scraper, $2.60/1k results
  instagramPost: 0.0027, // Apify instagram-post-scraper, $2.70/1k, per post (depth)
  // Identity verification of the IG candidate: the LLM judge plus, worst case,
  // a Perplexity fallback + a second IG scrape. Bundled into the IG reservation.
  instagramVerify: 0.01,
  facebook: 0.01, // Apify facebook-pages-scraper, $10/1k pages, one page
  firecrawlSearch: 0.001, // Firecrawl Search, 2 credits/10 results (~$0.0008/credit)
  perplexity: 0.01, // Perplexity Agent (pro-search): web search $0.005 + sonar tokens
  synthesisEconomy: 0.002, // gpt-4o-mini synthesis ($0.15/$0.60 per 1M in/out)
  synthesisStandard: 0.028, // gpt-4o synthesis ($2.50/$10 per 1M in/out)
  visionPerImage: 0.001, // gpt-4o-mini vision, one image (detail:low)
  visionPerImageStandard: 0.008, // gpt-4o vision, one image
  sort: 0.001, // gpt-4o-mini text sort / short judge
} as const;

// One photo candidate + which source it came from (drives the per-source
// analyze caps in the image funnel).
export type Img = { url: string; source: "google" | "website" | "instagram" };

export type MediaAssetPayload = {
  source: Img["source"];
  source_url: string;
  likes_count?: number | null;
  caption?: string | null;
  analysis?: string | null;
  source_metadata?: Record<string, unknown> | null;
};

export type EnrichConfig = {
  synthesisQuality: string;
  // Admin "Image model" knob — which model DESCRIBES photos (S5). The text
  // sort (S6) and utility judges stay on the cheap VISION_MODEL, matching the
  // admin cost calculator's lines.
  visionQuality: string;
  // GATHER caps — how many to PULL per source before anything else.
  gatherGoogleImages: number;
  // Instagram: DEPTH = posts pulled from the scrape (1–30); POSTS = kept after
  // the likes-sort (0–10, ≤ depth). Google needs no depth — it returns photos
  // pre-sorted best→worst, so gatherGoogleImages IS the preselection.
  gatherInstagramDepth: number;
  gatherInstagramPosts: number;
  // Per-source Firecrawl Search candidate counts for link discovery (S4).
  // Keyed by ChannelField-ish source name; 0 disables a source.
  discoverCandidates: {
    website_url: number;
    instagram_url: number;
    facebook_url: number;
    opentable_url: number;
    uber_eats_url: number;
  };
  // SAVE cap — final count persisted, SOURCE-INDEPENDENT, after analyze + sort.
  saveTotalImages: number;
  // S9 gate — mirror the selected gallery into Supabase Storage. When false the
  // pipeline skips the upload and photos render from their source URLs only.
  saveImagesToStorage: boolean;
  visionEnabled: boolean;
  // ANALYZE caps — how many gathered images per source go to vision.
  analyzeGoogleImages: number;
  analyzeInstagramImages: number;
  imageAnalysisPrompt: string;
  imageSortingPrompt: string;
};

const DEFAULT_ANALYSIS_PROMPT =
  "Describe this place photo: subject (ambiance / interior / exterior / food / people / detail), visual quality, lighting, and whether it is representative and appealing. Be concise and factual.";
const DEFAULT_SORTING_PROMPT =
  "Rank these place photos best to worst for a should-we-go-tonight decision. We sell EXPERIENCES: weight beautiful place / ambiance / vibe shots EQUALLY with food. Favor visual quality, representativeness, and a balanced mix. Drop duplicates, blurry, dark, or text-heavy images.";

// Read the Atlas admin knobs from app_settings (row id=1) and derive the step
// gates. The select is a single string LITERAL on purpose: supabase-js infers
// the row type only from a literal argument — anything that widens to `string`
// falls back to GenericStringError and untypes cfg.atlas_*.
export async function loadEnrichConfig(admin: SupabaseClient): Promise<EnrichConfig> {
  const { data: cfg } = await admin
    .from("app_settings")
    .select(
      "atlas_synthesis_quality, atlas_vision_quality, atlas_gather_google_images, atlas_gather_instagram_depth, atlas_gather_instagram_posts, atlas_save_total_images, atlas_save_images_to_storage, atlas_image_vision_enabled, atlas_analyze_google_images, atlas_analyze_instagram_images, atlas_image_analysis_prompt, atlas_image_sorting_prompt, atlas_discover_website_n, atlas_discover_instagram_n, atlas_discover_facebook_n, atlas_discover_opentable_n, atlas_discover_ubereats_n",
    )
    .eq("id", 1)
    .maybeSingle();

  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;

  return {
    synthesisQuality: (cfg?.atlas_synthesis_quality as string | undefined) ?? "economy",
    visionQuality: (cfg?.atlas_vision_quality as string | undefined) ?? "economy",
    gatherGoogleImages: num(cfg?.atlas_gather_google_images, 10),
    gatherInstagramDepth: num(cfg?.atlas_gather_instagram_depth, 30),
    gatherInstagramPosts: num(cfg?.atlas_gather_instagram_posts, 10),
    discoverCandidates: {
      website_url: num(cfg?.atlas_discover_website_n, 5),
      instagram_url: num(cfg?.atlas_discover_instagram_n, 5),
      facebook_url: num(cfg?.atlas_discover_facebook_n, 5),
      opentable_url: num(cfg?.atlas_discover_opentable_n, 3),
      uber_eats_url: num(cfg?.atlas_discover_ubereats_n, 2),
    },
    saveTotalImages: num(cfg?.atlas_save_total_images, 20),
    saveImagesToStorage: (cfg?.atlas_save_images_to_storage as boolean) ?? true,
    visionEnabled: (cfg?.atlas_image_vision_enabled as boolean) ?? true,
    analyzeGoogleImages: num(cfg?.atlas_analyze_google_images, 10),
    analyzeInstagramImages: num(cfg?.atlas_analyze_instagram_images, 10),
    imageAnalysisPrompt:
      (cfg?.atlas_image_analysis_prompt as string | undefined)?.trim() || DEFAULT_ANALYSIS_PROMPT,
    imageSortingPrompt:
      (cfg?.atlas_image_sorting_prompt as string | undefined)?.trim() || DEFAULT_SORTING_PROMPT,
  };
}
