// Supabase Edge Function — supabase-cron-enrich-place-analysis (artificial caller / cron)
//
// Stage 2 of the Enricher pipeline (the Enricher is a PROCESS — a cron-driven
// pipeline of three EFs — not an agent). The pg_cron poller claims
// place_research rows at stage='analysis' and fires this EF with
// { project_id }. It acks 202 immediately and runs the IMAGE half in a
// background task:
//
//   S5  vision describe — gpt-4o-mini describes the per-source analyze-capped
//       top of each candidate bucket (parallel, detail:low)
//   S6  rank + select — text model ranks the descriptions by the experience
//       rubric; diversity floor guarantees Instagram/website representation
//
// Input:  place_research.gathered.images (+ existing photos)
// Output: place_research.analysis { finalPhotos, saved, imageAnalysisByUrl }
//         → stage='contents'.
//
// Contract: verify_jwt=true; requireInternalCaller gates the service-role bearer.
//
// Local:  supabase functions serve supabase-cron-enrich-place-analysis
// Deploy: supabase functions deploy supabase-cron-enrich-place-analysis

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { loadEnrichConfig, PHOTO_CEILING, visionModelFor } from "../_shared/enrich-config.ts";
import { runImageFunnel } from "../_shared/enrich-image-funnel.ts";
import {
  advanceResearchStage,
  type AnalysisPayload,
  mapToObject,
  reportEnrichmentStep,
  serveEnrichStage,
} from "../_shared/enrich-pipeline.ts";

serveEnrichStage("analysis", async (admin, _env, row) => {
  const projectId = row.project_id;
  const gathered = row.gathered;
  if (!gathered) {
    // Research output missing (shouldn't happen) — send the row back to research.
    await advanceResearchStage(admin, projectId, "research");
    return;
  }

  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
  const cfg = await loadEnrichConfig(admin);

  const maxVisionImages = cfg.visionEnabled
    ? cfg.analyzeGoogleImages + cfg.analyzeInstagramImages
    : 0;
  const runVision = cfg.visionEnabled && !!OPENAI_KEY && maxVisionImages > 0;

  const funnel = await runImageFunnel({
    googleImages: gathered.images.google,
    instagramImages: gathered.images.instagram,
    existingPhotos: gathered.images.existingPhotos,
    gatherGoogleImages: cfg.gatherGoogleImages,
    saveTotalImages: cfg.saveTotalImages,
    photoCeiling: PHOTO_CEILING,
    runVision,
    openaiKey: OPENAI_KEY,
    visionModel: visionModelFor(cfg.visionQuality),
    analyze: {
      google: cfg.analyzeGoogleImages,
      instagram: cfg.analyzeInstagramImages,
    },
    imageAnalysisPrompt: cfg.imageAnalysisPrompt,
    imageSortingPrompt: cfg.imageSortingPrompt,
  });

  // One beacon for the whole analysis stage (S5–S6) — one notification per function.
  const described = funnel.imageAnalysisByUrl.size;
  await reportEnrichmentStep(admin, projectId, "S5", "images", "completed",
    `Image analysis complete — described ${described} candidate photo(s), selected ${funnel.finalPhotos.length} final photo(s) for the profile.`,
    { described, finalPhotos: funnel.finalPhotos.length });

  const analysis: AnalysisPayload = {
    finalPhotos: funnel.finalPhotos,
    saved: funnel.saved,
    imageAnalysisByUrl: mapToObject(funnel.imageAnalysisByUrl),
    diag: funnel.diag,
  };
  await advanceResearchStage(admin, projectId, "contents", { analysis });
});
