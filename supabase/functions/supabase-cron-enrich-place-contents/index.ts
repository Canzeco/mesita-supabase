// Supabase Edge Function — supabase-cron-enrich-place-contents (artificial caller / cron)
//
// Stage 3 (final) of the Enricher v2 pipeline. The pg_cron poller claims
// place_research rows at stage='contents' and fires this EF with { project_id }.
// It acks 200 immediately and runs the WRITE half in a background task:
//
//   S7  synthesis (About/details/menu, grounded ONLY in gathered material) +
//       category inference + tag inference (closed vocabularies)
//   S8  persist the enriched profile onto the places row (direct UPDATE — this
//       EF is already the DB layer; no HTTP hop) + content_status='ready'
//   S9  store images via enricher-agent-store-place-images (kept as an EF call
//       on purpose: the storage mirroring runs in that worker's own wall clock)
//
// Ends the pipeline: place_research.stage='done'. The gathered/analysis jsonb
// stay on the row, so re-synthesis without re-scraping = reset stage to
// 'contents' and let the poller re-run just this stage.
//
// Contract: verify_jwt=true; requireInternalCaller gates the service-role bearer.
//
// Local:  supabase functions serve supabase-cron-enrich-place-contents
// Deploy: supabase functions deploy supabase-cron-enrich-place-contents

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller, requireInternalCaller } from "../_shared/internal.ts";
import type { EFEnv } from "../_shared/auth.ts";
import { applyProfileToUpdate, synthesisModelFor, synthesizeProfile } from "../_shared/atlas-synthesis.ts";
import { loadAtlasConfig } from "../_shared/atlas-config.ts";
import { fetchPlaceCategories, inferPlaceCategory } from "../_shared/categories.ts";
import { fetchPlaceTags, inferPlaceTags } from "../_shared/tags.ts";
import { humanizeCategorySlug } from "../_shared/parse-utils.ts";
import {
  advanceResearchStage,
  type AnalysisPayload,
  buildMediaAssets,
  type GatheredPayload,
  loadClaimedRow,
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
  const rowRes = await loadClaimedRow(admin, projectId, "contents");
  if (!rowRes.ok) return json({ ok: false, error: rowRes.reason }, 409);
  const { gathered, analysis } = rowRes.row;
  if (!gathered) {
    await advanceResearchStage(admin, projectId, "research");
    return json({ ok: false, error: "gathered payload missing; row reset to research" }, 409);
  }
  if (!analysis) {
    await advanceResearchStage(admin, projectId, "analysis");
    return json({ ok: false, error: "analysis payload missing; row reset to analysis" }, 409);
  }

  runInBackground(runContents(admin, envRes.env, projectId, gathered, analysis));
  return json({ ok: true, accepted: true, stage: "contents", project_id: projectId }, 202);
});

async function runContents(
  admin: ReturnType<typeof adminClient>,
  env: EFEnv,
  projectId: string,
  gathered: GatheredPayload,
  analysis: AnalysisPayload,
): Promise<void> {
  try {
    const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
    if (!OPENAI_KEY) {
      await releaseResearchRow(admin, projectId, "server_misconfigured: missing OPENAI_KEY");
      return;
    }
    const cfg = await loadAtlasConfig(admin);

    const place: Record<string, unknown> = { ...gathered.place };
    const name = (place.name ?? "").toString();
    const category = (place.category ?? null) as string | null;
    const { igBio, googleReviewsText, siteMarkdown, serpSummary } = gathered.grounding;

    if (analysis.finalPhotos.length > 0) place.photos = analysis.finalPhotos;

    // ━━━ S7 — synthesis + category + tags ━━━
    const { parsed, diag: synthDiag } = await synthesizeProfile({
      openaiKey: OPENAI_KEY,
      model: synthesisModelFor(cfg.synthesisQuality),
      name,
      locationLine: gathered.locationLine,
      category,
      igBio,
      googleReviewsText,
      siteMarkdown,
      serpSummary,
    });
    const sources: Record<string, unknown> = { ...gathered.sources, image_funnel: analysis.diag, synthesis: synthDiag };
    if (parsed) applyProfileToUpdate(place, parsed);

    // Category + tags read the fresh synthesis output; run them in parallel.
    const [categoryList, tagVocabulary] = await Promise.all([
      fetchPlaceCategories(admin),
      fetchPlaceTags(admin),
    ]);
    // 'undefined' is the create-path placeholder, not a real category — never
    // offer it to the classifier (thin-signal places would land there).
    const realCategories = categoryList.filter((c) => c.slug !== "undefined");
    const [inferredCategory, inferredTags] = await Promise.all([
      inferPlaceCategory(OPENAI_KEY, realCategories, {
        name,
        address: (place.address ?? null) as string | null,
        editorialSummary: (place.editorial_summary ?? null) as string | null,
        // Best grounding available, in order: scraped material, then the
        // About we just synthesized (it exists even when scraping was thin).
        description: igBio || siteMarkdown.slice(0, 1200) ||
          ((place.description ?? null) as string | null)?.slice(0, 1200) || null,
      }),
      inferPlaceTags(OPENAI_KEY, tagVocabulary, {
        name,
        category,
        description: (place.description ?? null) as string | null,
        googleReviewsText,
        serpSummary,
      }),
    ]);
    if (inferredCategory) {
      place.category = inferredCategory;
      place.category_label =
        realCategories.find((c) => c.slug === inferredCategory)?.label ??
        humanizeCategorySlug(inferredCategory) ?? inferredCategory;
    }
    if (inferredTags.length > 0) place.tags = inferredTags;
    sources.category = { ok: !!inferredCategory, slug: inferredCategory, candidates: realCategories.length };
    sources.tags = { ok: inferredTags.length > 0, count: inferredTags.length, vocabulary: tagVocabulary.length };

    place.enriched_at = new Date().toISOString();
    place.enrichment_sources = sources;

    await reportEnrichmentStep(admin, projectId, "S7", "synthesis_category_tags", "completed",
      `Synthesis complete — wrote the About summary, set category “${place.category ?? "n/a"}”, and applied ${inferredTags.length} tag(s).`,
      { category: place.category ?? null, tags: inferredTags.length });

    // ━━━ S8 — persist the profile (direct UPDATE; this EF IS the DB layer) ━━━
    // Strip identity/timestamps so the DB owns them; keys absent are untouched
    // (same contract as the retired enricher-agent-write-place-data hop).
    const { id: _dropId, created_at: _dropCreated, updated_at: _dropUpdated, ...placeUpdate } =
      place as Record<string, unknown> & { id?: unknown; created_at?: unknown; updated_at?: unknown };
    const { error: placeErr } = await admin.from("places").update(placeUpdate).eq("id", projectId);
    if (placeErr) {
      await reportEnrichmentStep(admin, projectId, "S8", "data_persisted", "failed",
        "Profile persist failed — the place record was not updated.", { error: placeErr.message });
      await releaseResearchRow(admin, projectId, `place_update: ${placeErr.message}`);
      return;
    }
    const { error: projErr } = await admin
      .from("projects")
      .update({ content_status: "ready" })
      .eq("id", projectId);
    if (projErr) {
      await releaseResearchRow(admin, projectId, `content_status: ${projErr.message}`);
      return;
    }
    await reportEnrichmentStep(admin, projectId, "S8", "data_persisted", "completed",
      "Enriched profile persisted to the place record (ready).", { contentStatus: "ready" });

    // ━━━ S9 — store images (own EF: storage mirroring gets its own wall clock) ━━━
    const assets = buildMediaAssets(gathered, analysis);
    if (assets.length > 0) {
      const storeRes = await invokeArtificialCaller<{ queued?: number }>(
        env,
        "supabase-cron-enrich-place-contents",
        "enricher-agent-store-place-images",
        { project_id: projectId, assets, preferred_photo_urls: analysis.finalPhotos },
      );
      if (storeRes.ok) {
        await reportEnrichmentStep(admin, projectId, "S9", "images_stored", "completed",
          `Stored ${storeRes.data.queued ?? assets.length} image(s) to the media bucket — enrichment run complete.`,
          { queued: storeRes.data.queued ?? assets.length });
      } else {
        // Profile is saved; image mirroring failed. Report and finish anyway —
        // photos still render from source URLs and a re-run can re-mirror.
        await reportEnrichmentStep(admin, projectId, "S9", "images_stored", "failed",
          "Image storage failed — profile saved but media were not stored.", { error: storeRes.error });
      }
    } else {
      await reportEnrichmentStep(admin, projectId, "S9", "images_stored", "skipped",
        "No candidate images gathered — nothing to store.");
    }

    await advanceResearchStage(admin, projectId, "done");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[supabase-cron-enrich-place-contents]", msg);
    await releaseResearchRow(admin, projectId, `contents_crash: ${msg}`);
  }
}
