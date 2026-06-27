// Supabase Edge Function — admin-enrich-place (admin caller)
//
// Super-admin tool to (re)run deep enrichment on an existing place. New places
// are enriched automatically at create time (xxx-create-unit → triggerEnrichPlace
// → n8n Enricher); this is the manual lever to re-run the full async Enricher on
// a place after the fact (e.g. a bad first pass, or new source coverage). Both
// paths fire the same n8n webhook, so profiles stay consistent.
//
// Flips the unit back to content_status='generating', then fires the n8n Enricher
// webhook (fire-and-forget). The Enricher recomputes the full profile and
// persists via atlas-update-unit-data + atlas-save-place-media, flipping the unit
// back to 'ready' when done.
//
// Body: { project_id: uuid }
// Response: { ok, project_id, enrichmentTriggered, enrichmentAsync, enrichmentError }.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";
import { triggerEnrichPlace } from "../_shared/n8n.ts";

type Body = { project_id?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);
  const guard = await requireSuperAdmin(admin, authRes.user);
  if (!guard.ok) return guard.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const projectId = (body.project_id ?? "").toString().trim();
  if (!projectId) return json({ ok: false, error: "project_id is required" }, 400);

  // The Enricher needs the Google placeId (its identity spine) — look it up from
  // the existing place row.
  const { data: place, error: placeErr } = await admin
    .from("places")
    .select("id, google_place_id")
    .eq("id", projectId)
    .maybeSingle();
  if (placeErr) {
    return json({ ok: false, error: `place_read: ${placeErr.message}` }, 400);
  }
  if (!place) {
    return json({ ok: false, code: "place_not_found", error: "No place exists for this project_id." }, 404);
  }
  const placeId = (place.google_place_id ?? "").toString().trim();
  if (!placeId) {
    return json({ ok: false, code: "no_place_id", error: "Place has no google_place_id to re-enrich." }, 400);
  }

  // Flip back to 'generating' so the UI shows the enriching state while the n8n
  // Enricher re-runs; it flips to 'ready' on completion via atlas-update-unit-data.
  await admin.from("projects").update({ content_status: "generating" }).eq("id", projectId);

  // Fire the n8n Enricher (fire-and-forget; a trigger failure leaves the unit at
  // 'generating' and it can be re-triggered).
  const trigger = await triggerEnrichPlace(projectId, placeId);

  return json({
    ok: true,
    project_id: projectId,
    enrichmentAsync: true,
    enrichmentTriggered: trigger.ok,
    enrichmentError: trigger.ok ? null : trigger.error ?? null,
  });
});
