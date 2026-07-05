// Supabase Edge Function — supabase-cron-enrich-place-analysis (artificial caller / cron)
//
// Stage 2 of the Enricher v2 pipeline. The pg_cron poller claims place_research
// rows at stage='analysis' and fires this EF with { project_id }. It acks 200
// immediately and runs the IMAGE half in a background task:
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
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import { loadAtlasConfig, PHOTO_CEILING } from "../_shared/enrich-config.ts";
import { runImageFunnel } from "../_shared/enrich-image-funnel.ts";
import {
  advanceResearchStage,
  type AnalysisPayload,
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
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const projectId = (bodyRes.body.project_id ?? "").toString().trim();
  if (!projectId) return json({ ok: false, error: "project_id is required" }, 400);

  const admin = adminClient(envRes.env);
  const rowRes = await loadClaimedRow(admin, projectId, "analysis");
  if (!rowRes.ok) return json({ ok: false, error: rowRes.reason }, 409);
  const gathered = rowRes.row.gathered;
  if (!gathered) {
    // Research output missing (shouldn't happen) — send the row back to research.
    await advanceResearchStage(admin, projectId, "research");
    return json({ ok: false, error: "gathered payload missing; row reset to research" }, 409);
  }

  runInBackground(runAnalysis(admin, projectId, gathered));
  return json({ ok: true, accepted: true, stage: "analysis", project_id: projectId }, 202);
});

async function runAnalysis(
  admin: ReturnType<typeof adminClient>,
  projectId: string,
  gathered: GatheredPayload,
): Promise<void> {
  try {
    const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
    const cfg = await loadAtlasConfig(admin);

    const maxVisionImages = cfg.visionEnabled
      ? cfg.analyzeGoogleImages + cfg.analyzeWebsiteImages + cfg.analyzeInstagramImages
      : 0;
    const runVision = cfg.visionEnabled && !!OPENAI_KEY && maxVisionImages > 0;

    const funnel = await runImageFunnel({
      googleImages: gathered.images.google,
      websiteImages: gathered.images.website,
      instagramImages: gathered.images.instagram,
      existingPhotos: gathered.images.existingPhotos,
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

    const described = funnel.imageAnalysisByUrl.size;
    await reportEnrichmentStep(admin, projectId, "S5", "image_descriptions", "completed",
      `Vision pass done — described ${described} candidate photo(s) for ranking.`,
      { described });
    await reportEnrichmentStep(admin, projectId, "S6", "image_ranking", "completed",
      `Image ranking done — selected ${funnel.finalPhotos.length} final photo(s) for the profile.`,
      { finalPhotos: funnel.finalPhotos.length });

    const analysis: AnalysisPayload = {
      finalPhotos: funnel.finalPhotos,
      saved: funnel.saved,
      imageAnalysisByUrl: mapToObject(funnel.imageAnalysisByUrl),
      diag: funnel.diag,
    };
    await advanceResearchStage(admin, projectId, "contents", { analysis });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[supabase-cron-enrich-place-analysis]", msg);
    await releaseResearchRow(admin, projectId, `analysis_crash: ${msg}`);
  }
}
