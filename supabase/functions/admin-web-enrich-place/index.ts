// Supabase Edge Function — admin-web-enrich-place (natural caller / admin)
//
// Manual re-enrich trigger for a single existing place. Given a project_id,
// re-seeds the Enricher pipeline row (place_research) back to stage='research'
// via seedPlaceResearch (an upsert built for exactly this — see its doc). The
// pg_cron poller (run_place_enrichment_stages) then re-runs the full
// research → analysis → contents pipeline against the place, refreshing its
// Google spine, channels, reviews, images and generated copy.
//
// This is the button behind the admin Place editor's "Re-enrich" action. The
// place must already exist and carry a google_place_id (the pipeline's identity
// spine); an admin-created 'undefined' place still has one from create time.
//
// Internal enricher control — super-admin gated, admin console only.
//
// Local:  supabase functions serve admin-web-enrich-place
// Deploy: supabase functions deploy admin-web-enrich-place

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv, requireSuperAdmin } from "../_shared/auth.ts";
import { seedPlaceResearch } from "../_shared/enrich-pipeline.ts";

// placeId is the MESITA-26 alias for the place-row id (== project_id here).
type Body = { projectId?: string; placeId?: string };

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

  // Resolve the identity spine the pipeline re-checks first (fetchGoogleBasics).
  // Without a google_place_id the research stage can't run, so reject early.
  const { data: project, error: projErr } = await admin
    .from("projects")
    .select("id, google_place_id")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return json({ ok: false, error: `projects: ${projErr.message}` }, 500);
  if (!project) return json({ ok: false, error: "Place not found" }, 404);
  const googlePlaceId = (project.google_place_id ?? "").toString().trim();
  if (!googlePlaceId) {
    return json(
      { ok: false, error: "Place has no Google Place ID — nothing to enrich from." },
      422,
    );
  }

  const seed = await seedPlaceResearch(admin, projectId, googlePlaceId, "admin-web-enrich-place");
  if (!seed.ok) return json({ ok: false, error: seed.error ?? "Failed to queue enrichment" }, 500);

  return json({ ok: true, enrichmentTriggered: true });
});
