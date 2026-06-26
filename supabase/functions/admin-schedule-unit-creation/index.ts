// Supabase Edge Function — admin-schedule-unit-creation (admin caller)
//
// The admin-app equivalent of consumer-schedule-unit-creation: enqueues a single
// staggered create for a Google Places `placeId` by inserting a row into
// public.scheduled_unit_creations. The pg_cron poller fires the service-gated
// atlas-run-scheduled-create EF for due rows. exec_at defaults to now(); the
// caller may pass an ISO timestamp to defer.
//
// Gating: operator JWT → the admin allowlist (requireSuperAdmin checks
// public.super_admins — the same gate every other admin-* EF uses).
//
// Local:  supabase functions serve admin-schedule-unit-creation
// Deploy: supabase functions deploy admin-schedule-unit-creation

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv, requireSuperAdmin } from "../_shared/auth.ts";

type Body = { placeId?: string; exec_at?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Authenticate the admin operator against the admin allowlist.
  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;
  const admin = adminClient(env);
  const guard = await requireSuperAdmin(admin, authRes.user, "Only admins can schedule unit creation.");
  if (!guard.ok) return guard.response;
  const createdBy = authRes.user.emailLower ?? authRes.user.id;

  // Parse input.
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  // exec_at optional — default now(). When provided it must parse.
  let execAt: string | undefined;
  if (bodyRes.body.exec_at != null) {
    const ms = Date.parse(bodyRes.body.exec_at);
    if (Number.isNaN(ms)) return json({ ok: false, error: "exec_at must be an ISO timestamp" }, 400);
    execAt = new Date(ms).toISOString();
  }

  const insert: Record<string, unknown> = { place_id: placeId, created_by: createdBy };
  if (execAt) insert.exec_at = execAt;

  const { data: row, error } = await admin
    .from("scheduled_unit_creations")
    .insert(insert)
    .select("id, exec_at")
    .single();
  if (error || !row) {
    return json({ ok: false, error: `schedule_insert: ${error?.message ?? "no row"}` }, 500);
  }

  return json({ ok: true, scheduled_id: row.id, exec_at: row.exec_at }, 201);
});
