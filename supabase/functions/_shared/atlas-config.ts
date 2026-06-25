// Atlas enrichment: run-time config + per-run cost budget + shared types.
//
// Every knob lives in app_settings and is read at run time — the DB is the
// single source of truth; callers never pass overrides. The cost budget is a
// safety valve (rough per-call USD estimates), not billing.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Vision + sort always run on the cheap multimodal model — image work doesn't
// need the synthesis-quality tier (which governs only the profile text model).
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

// Tier gates (Atlas catalog). Google/Mesita is the always-on spine.
// - SOCIAL_LAYER (≥2): Instagram / Facebook / Website / SERP.
// - RESERVATION_DELIVERY (≥3): OpenTable + UberEats.
// - NICHE_SOCIAL (≥3): YouTube / TikTok / TripAdvisor / Yelp (loyal to the
//   ADEA field pages, which place these at T3; flip to 4 if the re-tiering
//   migration supersedes them).
export const SOCIAL_LAYER_TIER = 2;
export const RESERVATION_DELIVERY_TIER = 3;
export const NICHE_SOCIAL_TIER = 3;

// Hard ceiling on photos persisted to the venue, regardless of per-source caps.
// Safety bound on the candidate pool before save (the real, source-independent
// save cap is atlas_save_total_images, applied at the end).
export const PHOTO_CEILING = 50;

// Atlas About target: a full public narrative, not a blurb. ~7 chars/word
// (word + space) gives a predictable synthesis budget.
export const ATLAS_DESCRIPTION_TARGET_WORDS = 1000;
export const ATLAS_DESCRIPTION_MAX = ATLAS_DESCRIPTION_TARGET_WORDS * 7;

// Rough per-call cost estimates (USD). Approximate but enough to make the
// per-run cap meaningful — it's a safety valve, not billing.
export const COST = {
  compass: 0.05, // Apify Google Maps (reviews + images)
  instagram: 0.02, // Apify IG profile scraper
  // Identity verification of the IG candidate: the LLM judge plus, worst case,
  // a Perplexity fallback + a second IG scrape. Bundled into the IG reservation.
  instagramVerify: 0.04,
  facebook: 0.02, // Apify FB pages scraper
  firecrawl: 0.01, // Firecrawl scrape
  perplexity: 0.01, // Perplexity Agent (pro-search) validate+fill
  synthesisEconomy: 0.005, // gpt-4o-mini synthesis
  synthesisStandard: 0.03, // gpt-4o synthesis
  visionPerImage: 0.002, // gpt-4o-mini vision, one image (detail:low)
  sort: 0.003, // gpt-4o-mini text sort
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

export type AtlasConfig = {
  tierCeiling: number;
  synthesisQuality: string;
  // GATHER caps — how many to PULL per source before anything else.
  gatherGoogleImages: number;
  gatherWebsiteImages: number;
  gatherInstagramPosts: number;
  websiteCrawlMaxPages: number;
  // SAVE cap — final count persisted, SOURCE-INDEPENDENT, after analyze + sort.
  saveTotalImages: number;
  visionEnabled: boolean;
  // ANALYZE caps — how many gathered images per source go to vision.
  analyzeGoogleImages: number;
  analyzeWebsiteImages: number;
  analyzeInstagramImages: number;
  imageAnalysisPrompt: string;
  imageSortingPrompt: string;
  costCapUsd: number;
  // Derived tier gates.
  socialLayer: boolean;
  reservationDeliveryLayer: boolean;
  nicheSocialLayer: boolean;
};

const DEFAULT_ANALYSIS_PROMPT =
  "Describe this venue photo: subject (ambiance / interior / exterior / food / people / detail), visual quality, lighting, and whether it is representative and appealing. Be concise and factual.";
const DEFAULT_SORTING_PROMPT =
  "Rank these venue photos best to worst for a should-we-go-tonight decision. We sell EXPERIENCES: weight beautiful place / ambiance / vibe shots EQUALLY with food. Favor visual quality, representativeness, and a balanced mix. Drop duplicates, blurry, dark, or text-heavy images.";

// Read the Atlas admin knobs from app_settings (row id=1) and derive the tier
// gates. The select is a single string LITERAL on purpose: supabase-js infers
// the row type only from a literal argument — anything that widens to `string`
// falls back to GenericStringError and untypes cfg.atlas_*.
export async function loadAtlasConfig(admin: SupabaseClient): Promise<AtlasConfig> {
  const { data: cfg } = await admin
    .from("app_settings")
    .select(
      "atlas_source_tier_ceiling, atlas_synthesis_quality, atlas_gather_google_images, atlas_gather_website_images, atlas_gather_instagram_posts, atlas_save_total_images, atlas_image_vision_enabled, atlas_analyze_google_images, atlas_analyze_website_images, atlas_analyze_instagram_images, atlas_image_analysis_prompt, atlas_image_sorting_prompt, atlas_per_run_cost_cap_usd, atlas_website_crawl_max_pages",
    )
    .eq("id", 1)
    .maybeSingle();

  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const tierCeiling = num(cfg?.atlas_source_tier_ceiling, 3);

  return {
    tierCeiling,
    synthesisQuality: (cfg?.atlas_synthesis_quality as string | undefined) ?? "economy",
    gatherGoogleImages: num(cfg?.atlas_gather_google_images, 10),
    gatherWebsiteImages: num(cfg?.atlas_gather_website_images, 10),
    gatherInstagramPosts: num(cfg?.atlas_gather_instagram_posts, 10),
    websiteCrawlMaxPages: Math.max(1, num(cfg?.atlas_website_crawl_max_pages, 5)),
    saveTotalImages: num(cfg?.atlas_save_total_images, 20),
    visionEnabled: (cfg?.atlas_image_vision_enabled as boolean) ?? true,
    analyzeGoogleImages: num(cfg?.atlas_analyze_google_images, 10),
    analyzeWebsiteImages: num(cfg?.atlas_analyze_website_images, 10),
    analyzeInstagramImages: num(cfg?.atlas_analyze_instagram_images, 10),
    imageAnalysisPrompt:
      (cfg?.atlas_image_analysis_prompt as string | undefined)?.trim() || DEFAULT_ANALYSIS_PROMPT,
    imageSortingPrompt:
      (cfg?.atlas_image_sorting_prompt as string | undefined)?.trim() || DEFAULT_SORTING_PROMPT,
    costCapUsd: num(Number(cfg?.atlas_per_run_cost_cap_usd), 1.0) || 1.0,
    socialLayer: tierCeiling >= SOCIAL_LAYER_TIER,
    reservationDeliveryLayer: tierCeiling >= RESERVATION_DELIVERY_TIER,
    nicheSocialLayer: tierCeiling >= NICHE_SOCIAL_TIER,
  };
}

// Per-run USD budget. reserve() BEFORE each step, in priority order — a step
// that doesn't fit the remaining budget is disabled (its reserve returns false),
// so the run never exceeds the per-run cap.
export type Budget = {
  reserve: (label: string, c: number) => boolean;
  cost: Record<string, number>;
  spent: () => number;
};

export function createBudget(capUsd: number): Budget {
  let plannedUsd = 0;
  const cost: Record<string, number> = {};
  return {
    cost,
    reserve(label, c) {
      if (plannedUsd + c > capUsd) return false;
      plannedUsd += c;
      cost[label] = c;
      return true;
    },
    spent: () => plannedUsd,
  };
}
