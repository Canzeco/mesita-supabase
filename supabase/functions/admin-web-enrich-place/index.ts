// Supabase Edge Function — admin-web-enrich-place (natural caller / admin)
//
// Manual re-enrich trigger for a single existing place. Given a project_id and a
// `mode`, it reseeds the Enricher pipeline row (place_research) so the pg_cron
// poller (run_place_enrichment_stages) re-runs from a chosen stage:
//
//   mode 'full'      → reseed to stage='research' (fresh gather; nulls the stored
//                      gathered/analysis) → research → analysis → contents.
//                      Refreshes the Google spine, channels, reviews, images, and
//                      generated copy. Phone is re-fetched + overridden here.
//   mode 'analysis'  → reseed to stage='analysis' (REUSES stored gathered) →
//                      analysis → contents. Re-ranks/rebuilds images + re-persists,
//                      WITHOUT re-gathering. Phone/contacts left untouched.
//   mode 'contents'  → reseed to stage='contents' (REUSES stored gathered +
//                      analysis) → contents only. Re-synthesises copy/category/tags
//                      + re-persists. Cheapest. Phone/contacts left untouched.
//
// The lighter modes need a prior full run to have populated the payloads they
// reuse (gathered for 'analysis'; gathered + analysis for 'contents'); if those
// are missing we reject with 422 so the admin runs a full re-enrich first, rather
// than silently self-healing into an unexpected full run.
//
// This is the button behind the admin Place editor's re-enrich actions. The place
// must already exist and carry a google_place_id (the pipeline's identity spine);
// an admin-created 'undefined' place still has one from create time.
//
// Internal enricher control — super-admin gated, admin console only.
//
// Local:  supabase functions serve admin-web-enrich-place
// Deploy: supabase functions deploy admin-web-enrich-place

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv, requireSuperAdmin } from "../_shared/auth.ts";
import { advanceResearchStage, markProjectGenerating, seedPlaceResearch } from "../_shared/enrich-pipeline.ts";

// placeId is the MESITA-26 alias for the place-row id (== project_id here).
type ReenrichMode = "full" | "analysis" | "contents";
type Body = { projectId?: string; placeId?: string; mode?: string };

const MODES: ReenrichMode[] = ["full", "analysis", "contents"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);
  const guard = await requireSuperAdmin(admin, authRes.user, "Only admins can re-enrich places.");
  if (!guard.ok) return guard.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const projectId = (bodyRes.body.projectId ?? bodyRes.body.placeId ?? "").toString().trim();
  if (!projectId) return json({ ok: false, error: "Missing projectId" }, 400);

  // Default to 'full' so legacy callers (no mode) keep the old behaviour.
  const mode = (bodyRes.body.mode ?? "full").toString().trim() as ReenrichMode;
  if (!MODES.includes(mode)) {
    return json({ ok: false, error: `Invalid mode '${mode}'. Expected one of: ${MODES.join(", ")}.` }, 400);
  }

  // Resolve the identity spine the pipeline re-checks first (fetchGoogleBasics).
  // google_place_id lives on the places base table (places.id == the project id
  // == the editor's projectId); the projects table has no such column. Without
  // it the research stage can't run, so reject early.
  const { data: place, error: placeErr } = await admin
    .from("places")
    .select("id, google_place_id")
    .eq("id", projectId)
    .maybeSingle();
  if (placeErr) return json({ ok: false, error: `places: ${placeErr.message}` }, 500);
  if (!place) return json({ ok: false, error: "Place not found" }, 404);
  const googlePlaceId = (place.google_place_id ?? "").toString().trim();
  if (!googlePlaceId) {
    return json(
      { ok: false, error: "Place has no Google Place ID — nothing to enrich from." },
      422,
    );
  }

  // ── Full re-enrich: reseed to 'research' (nulls stored payloads). ──
  if (mode === "full") {
    const seed = await seedPlaceResearch(admin, projectId, googlePlaceId, "admin-web-enrich-place");
    if (!seed.ok) return json({ ok: false, error: seed.error ?? "Failed to queue enrichment" }, 500);
    return json({ ok: true, enrichmentTriggered: true, mode, stage: "research" });
  }

  // ── Lighter modes: reseed to the chosen stage, REUSING the stored payloads.
  // Require that a prior full run populated what the stage depends on. ──
  const stage: "analysis" | "contents" = mode === "analysis" ? "analysis" : "contents";
  const { data: row, error: rowErr } = await admin
    .from("place_research")
    .select("gathered, analysis")
    .eq("project_id", projectId)
    .maybeSingle();
  if (rowErr) return json({ ok: false, error: `place_research: ${rowErr.message}` }, 500);
  if (!row) {
    return json(
      { ok: false, error: "No enrichment run exists for this place yet — run a full re-enrich first." },
      422,
    );
  }
  if (!row.gathered) {
    return json(
      { ok: false, error: "No gathered research data — run a full re-enrich first." },
      422,
    );
  }
  if (stage === "contents" && !row.analysis) {
    return json(
      { ok: false, error: "No analysis data — run a full or analysis re-enrich first." },
      422,
    );
  }

  // advanceResearchStage reseeds (stage + status='pending' + attempts=0) without
  // touching gathered/analysis — the poller re-claims the row at the chosen stage.
  // MESITA-453: Enriching covers the whole pipeline (research|analysis|contents),
  // so flip content_status back to generating for light re-enrich modes too.
  await markProjectGenerating(admin, projectId);
  await advanceResearchStage(admin, projectId, stage);
  return json({ ok: true, enrichmentTriggered: true, mode, stage });
});
