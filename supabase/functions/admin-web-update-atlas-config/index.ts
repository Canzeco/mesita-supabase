// Supabase Edge Function — admin-web-update-atlas-config
//
// Naming: caller-verb-words. Caller = admin, verb = update, words = atlas-config.
//
// Partial-update of the Atlas research knobs on public.app_settings, written
// from the admin console's Atlas → Configuration page. Each field is
// optional; only the keys present in the body are written, so the UI can
// save one control at a time:
//
//   gatherGoogleImages (1–10)
//   gatherInstagramDepth (1–50, download) / gatherInstagramPosts (1–50, keep ≤ depth)
//   gatherReviews (0–100) → atlas_gather_reviews (Apify Google reviews pulled)
//   analyzeGoogleImages (1–10, ≤ gatherGoogleImages) /
//     analyzeInstagramImages (1–50, ≤ gatherInstagramPosts)
//   saveTotalImages (1–10, ≤ analyzeGoogle + analyzeInstagram) → atlas_save_total_images
//   saveImagesToStorage (boolean) → atlas_save_images_to_storage (S9 Storage-mirror gate)
//   discover{Website,Instagram,Facebook,Opentable,Ubereats}N (0–10, per-source
//     Firecrawl Search candidate counts for link discovery)
//   imageAnalysisPrompt / imageSortingPrompt
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Body = {
  // Image funnel — GATHER. Google: single pre-sorted cap (1–10). Instagram: split
  // into download DEPTH (1–30) + keep-count (1–30, ≤ depth).
  gatherGoogleImages?: number;
  gatherInstagramDepth?: number;
  gatherInstagramPosts?: number;
  // Google reviews pulled by the Apify Maps scrape (0–100).
  gatherReviews?: number;
  // Image funnel — ANALYZE (per source: Google ≤ its keep, IG ≤ its keep) +
  // final SAVE (1–10, ≤ analyzed total, all sources).
  imageVisionEnabled?: boolean;
  analyzeGoogleImages?: number;
  analyzeInstagramImages?: number;
  saveTotalImages?: number;
  // S9 gate — mirror the selected gallery into Supabase Storage (default true).
  saveImagesToStorage?: boolean;
  imageAnalysisPrompt?: string;
  imageSortingPrompt?: string;
  synthesisQuality?: string;
  visionQuality?: string;
  // Perplexity Agent preset for S2/S3 ("search model").
  perplexityPreset?: string;
  perRunCostCapUsd?: number;
  // Link discovery — per-source Firecrawl Search candidate counts (0–10).
  discoverWebsiteN?: number;
  discoverInstagramN?: number;
  discoverFacebookN?: number;
  discoverOpentableN?: number;
  discoverUbereatsN?: number;
};

const QUALITY_VALUES = new Set(["economy", "standard", "high"]);
const PERPLEXITY_PRESETS = new Set([
  "fast-search",
  "pro-search",
  "deep-research",
  "advanced-deep-research",
]);

function intInRange(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v < min || v > max) return null;
  return v;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const patch: Record<string, unknown> = {};

  // ── Gather caps (pull per source) ───────────────────────────────────────
  if (body.gatherGoogleImages !== undefined) {
    const n = intInRange(body.gatherGoogleImages, 1, 10);
    if (n === null) {
      return json({ ok: false, error: "gatherGoogleImages must be an integer 1-10" }, 400);
    }
    patch.atlas_gather_google_images = n;
  }

  if (body.gatherInstagramDepth !== undefined) {
    const n = intInRange(body.gatherInstagramDepth, 1, 50);
    if (n === null) {
      return json({ ok: false, error: "gatherInstagramDepth must be an integer 1-50" }, 400);
    }
    patch.atlas_gather_instagram_depth = n;
  }

  if (body.gatherInstagramPosts !== undefined) {
    const n = intInRange(body.gatherInstagramPosts, 1, 50);
    if (n === null) {
      return json({ ok: false, error: "gatherInstagramPosts must be an integer 1-50" }, 400);
    }
    patch.atlas_gather_instagram_posts = n;
  }

  if (body.gatherReviews !== undefined) {
    const n = intInRange(body.gatherReviews, 0, 100);
    if (n === null) {
      return json({ ok: false, error: "gatherReviews must be an integer 0-100" }, 400);
    }
    patch.atlas_gather_reviews = n;
  }

  // ── Analysis ──────────────────────────────────────────────────────────
  if (body.imageVisionEnabled !== undefined) {
    if (typeof body.imageVisionEnabled !== "boolean") {
      return json({ ok: false, error: "imageVisionEnabled must be a boolean" }, 400);
    }
    patch.atlas_image_vision_enabled = body.imageVisionEnabled;
  }

  if (body.saveTotalImages !== undefined) {
    const n = intInRange(body.saveTotalImages, 1, 10);
    if (n === null) {
      return json({ ok: false, error: "saveTotalImages must be an integer 1-10" }, 400);
    }
    patch.atlas_save_total_images = n;
  }

  if (body.saveImagesToStorage !== undefined) {
    if (typeof body.saveImagesToStorage !== "boolean") {
      return json({ ok: false, error: "saveImagesToStorage must be a boolean" }, 400);
    }
    patch.atlas_save_images_to_storage = body.saveImagesToStorage;
  }

  if (body.analyzeGoogleImages !== undefined) {
    const n = intInRange(body.analyzeGoogleImages, 1, 10);
    if (n === null) {
      return json({ ok: false, error: "analyzeGoogleImages must be an integer 1-10" }, 400);
    }
    patch.atlas_analyze_google_images = n;
  }

  if (body.imageAnalysisPrompt !== undefined) {
    if (typeof body.imageAnalysisPrompt !== "string" || body.imageAnalysisPrompt.length > 4000) {
      return json({ ok: false, error: "imageAnalysisPrompt must be a string up to 4000 chars" }, 400);
    }
    patch.atlas_image_analysis_prompt = body.imageAnalysisPrompt;
  }

  if (body.imageSortingPrompt !== undefined) {
    if (typeof body.imageSortingPrompt !== "string" || body.imageSortingPrompt.length > 4000) {
      return json({ ok: false, error: "imageSortingPrompt must be a string up to 4000 chars" }, 400);
    }
    patch.atlas_image_sorting_prompt = body.imageSortingPrompt;
  }

  if (body.analyzeInstagramImages !== undefined) {
    const n = intInRange(body.analyzeInstagramImages, 1, 50);
    if (n === null) {
      return json({ ok: false, error: "analyzeInstagramImages must be an integer 1-50" }, 400);
    }
    patch.atlas_analyze_instagram_images = n;
  }

  if (body.synthesisQuality !== undefined) {
    if (
      typeof body.synthesisQuality !== "string" ||
      !QUALITY_VALUES.has(body.synthesisQuality)
    ) {
      return json(
        { ok: false, error: "synthesisQuality must be economy, standard, or high" },
        400,
      );
    }
    patch.atlas_synthesis_quality = body.synthesisQuality;
  }

  if (body.visionQuality !== undefined) {
    if (
      typeof body.visionQuality !== "string" ||
      !QUALITY_VALUES.has(body.visionQuality)
    ) {
      return json(
        { ok: false, error: "visionQuality must be economy, standard, or high" },
        400,
      );
    }
    patch.atlas_vision_quality = body.visionQuality;
  }

  if (body.perplexityPreset !== undefined) {
    if (
      typeof body.perplexityPreset !== "string" ||
      !PERPLEXITY_PRESETS.has(body.perplexityPreset)
    ) {
      return json(
        {
          ok: false,
          error:
            "perplexityPreset must be fast-search, pro-search, deep-research, or advanced-deep-research",
        },
        400,
      );
    }
    patch.atlas_perplexity_preset = body.perplexityPreset;
  }

  if (body.perRunCostCapUsd !== undefined) {
    if (typeof body.perRunCostCapUsd !== "number" || body.perRunCostCapUsd < 0) {
      return json(
        { ok: false, error: "perRunCostCapUsd must be a number >= 0" },
        400,
      );
    }
    // Cap precision to 2 decimals to match numeric(8,2).
    patch.atlas_per_run_cost_cap_usd = Math.round(body.perRunCostCapUsd * 100) / 100;
  }

  // ── Link discovery — per-source Firecrawl Search candidate counts (0–10) ──
  const discoverKnobs: [keyof Body, string][] = [
    ["discoverWebsiteN", "atlas_discover_website_n"],
    ["discoverInstagramN", "atlas_discover_instagram_n"],
    ["discoverFacebookN", "atlas_discover_facebook_n"],
    ["discoverOpentableN", "atlas_discover_opentable_n"],
    ["discoverUbereatsN", "atlas_discover_ubereats_n"],
  ];
  for (const [bodyKey, col] of discoverKnobs) {
    const raw = body[bodyKey];
    if (raw === undefined) continue;
    const n = intInRange(raw, 0, 10);
    if (n === null) {
      return json({ ok: false, error: `${bodyKey} must be an integer 0-10` }, 400);
    }
    patch[col] = n;
  }

  // ── Image-funnel per-source lock ────────────────────────────────────────
  // Authoritative backstop for the admin console's client-side clamp. Every
  // downstream count is bounded by its OWN source upstream — not by a shared
  // sum, which would let one source's slack mask another's overflow (e.g.
  // analyze 15 IG posts when only 10 were kept). Partial updates touch one
  // field at a time, so merge the patch over the current row before checking:
  //   IG keep ≤ IG depth · analyze ≤ keep per source · save ≤ analyzed total.
  const FUNNEL_COLS = [
    "atlas_gather_google_images",
    "atlas_gather_instagram_depth",
    "atlas_gather_instagram_posts",
    "atlas_analyze_google_images",
    "atlas_analyze_instagram_images",
    "atlas_save_total_images",
  ] as const;
  if (FUNNEL_COLS.some((c) => c in patch)) {
    const { data: cur } = await admin
      .from("app_settings")
      .select(
        "atlas_gather_google_images, atlas_gather_instagram_depth, atlas_gather_instagram_posts, atlas_analyze_google_images, atlas_analyze_instagram_images, atlas_save_total_images",
      )
      .eq("id", 1)
      .maybeSingle();
    const eff = (c: (typeof FUNNEL_COLS)[number]): number => {
      const p = patch[c];
      if (typeof p === "number") return p;
      const v = (cur as Record<string, unknown> | null)?.[c];
      return typeof v === "number" ? v : 0;
    };
    const googleKeep = eff("atlas_gather_google_images");
    const igDepth = eff("atlas_gather_instagram_depth");
    const igKeep = eff("atlas_gather_instagram_posts");
    const googleAnalyze = eff("atlas_analyze_google_images");
    const igAnalyze = eff("atlas_analyze_instagram_images");
    const save = eff("atlas_save_total_images");
    if (igKeep > igDepth) {
      return json({
        ok: false,
        error: `Instagram keep (${igKeep}) can't exceed the download depth (${igDepth}).`,
      }, 400);
    }
    if (googleAnalyze > googleKeep) {
      return json({
        ok: false,
        error: `Google analyze (${googleAnalyze}) can't exceed Google images kept (${googleKeep}).`,
      }, 400);
    }
    if (igAnalyze > igKeep) {
      return json({
        ok: false,
        error: `Instagram analyze (${igAnalyze}) can't exceed Instagram images kept (${igKeep}).`,
      }, 400);
    }
    if (save > googleAnalyze + igAnalyze) {
      return json({
        ok: false,
        error: `Image selection (${save}) can't exceed the analysis total (${googleAnalyze + igAnalyze}).`,
      }, 400);
    }
  }

  if (Object.keys(patch).length === 0) {
    return json({ ok: false, error: "Nothing to update" }, 400);
  }
  patch.updated_by = userId;

  const { data, error } = await admin
    .from("app_settings")
    .update(patch)
    .eq("id", 1)
    .select(
      "atlas_gather_google_images, atlas_gather_instagram_depth, atlas_gather_instagram_posts, atlas_gather_reviews, atlas_image_vision_enabled, atlas_analyze_google_images, atlas_analyze_instagram_images, atlas_save_total_images, atlas_save_images_to_storage, atlas_image_analysis_prompt, atlas_image_sorting_prompt, atlas_synthesis_quality, atlas_vision_quality, atlas_perplexity_preset, atlas_per_run_cost_cap_usd, atlas_discover_website_n, atlas_discover_instagram_n, atlas_discover_facebook_n, atlas_discover_opentable_n, atlas_discover_ubereats_n, updated_at",
    )
    .single();
  if (error) {
    return json(
      { ok: false, error: `settings_update: ${error.message}` },
      500,
    );
  }

  return json({
    ok: true,
    atlasGatherGoogleImages: data.atlas_gather_google_images,
    atlasGatherInstagramDepth: data.atlas_gather_instagram_depth,
    atlasGatherInstagramPosts: data.atlas_gather_instagram_posts,
    atlasGatherReviews: data.atlas_gather_reviews,
    atlasImageVisionEnabled: data.atlas_image_vision_enabled,
    atlasAnalyzeGoogleImages: data.atlas_analyze_google_images,
    atlasAnalyzeInstagramImages: data.atlas_analyze_instagram_images,
    atlasSaveTotalImages: data.atlas_save_total_images,
    atlasSaveImagesToStorage: data.atlas_save_images_to_storage,
    atlasImageAnalysisPrompt: data.atlas_image_analysis_prompt,
    atlasImageSortingPrompt: data.atlas_image_sorting_prompt,
    atlasSynthesisQuality: data.atlas_synthesis_quality,
    atlasVisionQuality: data.atlas_vision_quality,
    atlasPerplexityPreset: data.atlas_perplexity_preset,
    atlasPerRunCostCapUsd: data.atlas_per_run_cost_cap_usd,
    atlasDiscoverWebsiteN: data.atlas_discover_website_n,
    atlasDiscoverInstagramN: data.atlas_discover_instagram_n,
    atlasDiscoverFacebookN: data.atlas_discover_facebook_n,
    atlasDiscoverOpentableN: data.atlas_discover_opentable_n,
    atlasDiscoverUbereatsN: data.atlas_discover_ubereats_n,
    updatedAt: data.updated_at,
  });
});
