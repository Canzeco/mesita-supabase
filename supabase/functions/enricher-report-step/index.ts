// Supabase Edge Function — enricher-report-step (artificial caller / agent)
//
// Progress beacon for the n8n Enricher: one INSERT per completed (or failed)
// pipeline step into public.place_enrichment_events, which powers the admin
// console's global notifications feed (admin-list-notifications →
// atlas.enrichment_step items). The Enricher calls it from leaf branches after
// each stage, so a failure here must never break an enrichment run — the n8n
// nodes fire it with neverError + continue-on-error, and this EF stays tiny.
//
// Body: {
//   project_id: uuid          — the places/projects shared PK being enriched
//   step:       "S0".."S9"    — canonical Notion step number
//   step_name?: string        — machine slug, e.g. "google_profile"
//   status?:    "started" | "completed" | "failed" | "skipped"  (default "completed")
//   detail?:    string        — optional human line (≤500 chars)
//   meta?:      object        — small step metrics (photo counts, flags…)
// }
//
// Contract: verify_jwt=false; requireInternalCaller gates the service-role
// bearer + X-Internal-Caller header. Mirrors enricher-write-place-data gating.
//
// Local:  supabase functions serve enricher-report-step
// Deploy: supabase functions deploy enricher-report-step

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";

type Body = {
  project_id?: string;
  step?: string;
  step_name?: string;
  status?: string;
  detail?: string;
  meta?: Record<string, unknown>;
};

const STATUSES = new Set(["started", "completed", "failed", "skipped"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const b = bodyRes.body;

  const projectId = (b.project_id ?? "").toString().trim();
  if (!UUID_RE.test(projectId)) {
    return json({ ok: false, error: "project_id must be a uuid" }, 400);
  }
  const step = (b.step ?? "").toString().trim().toUpperCase();
  if (!/^S[0-9]$/.test(step)) {
    return json({ ok: false, error: "step must be S0–S9" }, 400);
  }
  const statusRaw = (b.status ?? "completed").toString().trim();
  const status = STATUSES.has(statusRaw) ? statusRaw : "completed";
  const stepName = (b.step_name ?? "").toString().trim().slice(0, 80) || step.toLowerCase();
  const detail = b.detail != null ? b.detail.toString().slice(0, 500) : null;
  const meta = b.meta && typeof b.meta === "object" && !Array.isArray(b.meta) ? b.meta : {};

  const admin = adminClient(envRes.env);
  const { data, error } = await admin
    .from("place_enrichment_events")
    .insert({ project_id: projectId, step, step_name: stepName, status, detail, meta })
    .select("id")
    .single();
  if (error) {
    // FK violation ⇒ the place row is gone (deleted mid-run); report, don't 500.
    if (error.code === "23503") {
      return json({ ok: false, code: "project_not_found", error: "No place exists for this project_id." }, 404);
    }
    return json({ ok: false, error: `event_insert: ${error.message}`, code: error.code ?? null }, 400);
  }

  return json({ ok: true, id: data.id, caller: callerRes.callerName }, 201);
});
