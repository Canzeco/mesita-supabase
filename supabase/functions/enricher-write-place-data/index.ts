// Supabase Edge Function — enricher-write-place-data (artificial caller / agent)
//
// The UPDATE half of the ASYNC enrich pipeline. The create path
// (xxx-create-unit) inserts a MINIMAL units/places row (content_status='generating')
// and then triggers the n8n Enricher. The Enricher recomputes the full profile
// via its native S1-S7 research and calls THIS function to persist it onto the
// EXISTING row — an UPDATE keyed by project_id, not an INSERT.
//
// Twin of enricher-save-place-data, but:
//   • UPDATEs `places` by id (the unit/place shared PK) instead of inserting
//   • requires the row to already exist (404 unit_not_found if not)
//   • flips units.content_status → 'ready' (default) or a caller-supplied terminal
//     state ('failed', so a failed Enricher run doesn't strand at 'generating')
//   • never touches id / slug / created_at — identity is owned by the create step
//
// The enriched `place` from the n8n Enricher is the authoritative full
// profile; only the keys it carries are written (columns it omits are left
// untouched), so a wholesale UPDATE cannot wipe data the create step seeded.
//
// Media is NOT handled here — the Enricher invokes enricher-store-place-images next
// with the media_assets get-enriched returned.
//
// Contract: verify_jwt=false; requireInternalCaller gates the service-role
// bearer. Mirrors enricher-save-place-data gating.
//
// Local:  supabase functions serve enricher-write-place-data
// Deploy: supabase functions deploy enricher-write-place-data

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";

// The places-shaped profile from the n8n Enricher. Required spine: name.
type PlacePayload = Record<string, unknown> & {
  google_place_id?: string;
  name?: string;
};
type Body = { project_id?: string; place?: PlacePayload; content_status?: string };

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
  const place = bodyRes.body.place;
  if (!projectId) return json({ ok: false, error: "project_id is required" }, 400);
  if (!place || typeof place !== "object") {
    return json({ ok: false, error: "place is required" }, 400);
  }
  const name = (place.name ?? "").toString().trim();
  if (!name) return json({ ok: false, error: "place.name is required" }, 400);

  // content_status is caller-controlled: a successful Enricher run lands 'ready'
  // (default); a failed run can pass 'failed' so the unit doesn't strand at
  // 'generating'. Whitelisted; invalid → 'ready'.
  const ADEA_STATUSES = new Set(["queued", "generating", "ready", "failed"]);
  const adeaRaw = (bodyRes.body.content_status ?? "ready").toString().trim();
  const adeaStatus = ADEA_STATUSES.has(adeaRaw) ? adeaRaw : "ready";

  const admin = adminClient(envRes.env);

  // ── Row must already exist (the create step inserted the minimal row) ──
  const { data: unit, error: unitReadErr } = await admin
    .from("projects")
    .select("id, slug, status")
    .eq("id", projectId)
    .maybeSingle();
  if (unitReadErr) {
    return json({ ok: false, error: `unit_read: ${unitReadErr.message}`, code: unitReadErr.code ?? null }, 400);
  }
  if (!unit) {
    return json({ ok: false, code: "unit_not_found", error: "No unit exists for this project_id." }, 404);
  }

  // ── 1) places (profile). Strip identity/timestamps so the DB owns them; the
  // enriched place is the authoritative full profile, keyed onto the existing
  // row by id. Keys absent from `place` are left untouched. ──
  const { id: _dropId, created_at: _dropCreated, updated_at: _dropUpdated, ...placeUpdate } = place;
  const { error: placeErr } = await admin
    .from("places")
    .update(placeUpdate)
    .eq("id", projectId);
  if (placeErr) {
    return json({ ok: false, error: `place_update: ${placeErr.message}`, code: placeErr.code ?? null }, 400);
  }

  // ── 2) units — enrichment terminal state (default 'ready'; 'failed' on a
  // failed Enricher run so the unit doesn't strand at 'generating') ──
  const { data: unitRow, error: unitErr } = await admin
    .from("projects")
    .update({ content_status: adeaStatus })
    .eq("id", projectId)
    .select("id, slug, status")
    .single();
  if (unitErr || !unitRow) {
    return json({ ok: false, error: `unit_update: ${unitErr?.message ?? "no row"}`, code: unitErr?.code ?? null }, 400);
  }

  return json(
    {
      ok: true,
      unit_id: unitRow.id,
      place_id: projectId,
      slug: unitRow.slug,
      name,
      status: unitRow.status,
      content_status: adeaStatus,
      caller: callerRes.callerName,
    },
    200,
  );
});
