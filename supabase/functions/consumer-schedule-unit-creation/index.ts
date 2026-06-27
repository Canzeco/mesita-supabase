// Supabase Edge Function — consumer-schedule-unit-creation (consumer caller)
//
// Enqueues a staggered create for a Google Places `placeId`. Instead of running
// the (expensive, synchronous) create pipeline inline, it inserts a row into
// public.scheduled_project_creations; the pg_cron poller picks due rows up and fires
// the service-gated atlas-run-scheduled-create EF. exec_at defaults to now() (run
// ASAP) but the caller may pass an ISO timestamp to defer.
//
// Gating: a signed-in consumer session (getAuthedUser). No DB write happens from
// the client — every write goes through this EF (client-DB-access rule); the EF
// uses the service-role key to insert into the service-role-only queue table.
//
// Local:  supabase functions serve consumer-schedule-unit-creation
// Deploy: supabase functions deploy consumer-schedule-unit-creation

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";

type Body = { placeId?: string; exec_at?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Authenticate the consumer.
  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;
  const createdBy = authRes.user.id;

  // Parse input.
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  // exec_at optional — default now() (DB column default). When provided it must
  // parse as a valid timestamp; an unparseable value is a 400, not a silent now().
  let execAt: string | undefined;
  if (bodyRes.body.exec_at != null) {
    const ms = Date.parse(bodyRes.body.exec_at);
    if (Number.isNaN(ms)) return json({ ok: false, error: "exec_at must be an ISO timestamp" }, 400);
    execAt = new Date(ms).toISOString();
  }

  const admin = adminClient(env);

  const insert: Record<string, unknown> = { place_id: placeId, created_by: createdBy };
  if (execAt) insert.exec_at = execAt;

  const { data: row, error } = await admin
    .from("scheduled_project_creations")
    .insert(insert)
    .select("id, exec_at")
    .single();
  if (error || !row) {
    return json({ ok: false, error: `schedule_insert: ${error?.message ?? "no row"}` }, 500);
  }

  return json({ ok: true, scheduled_id: row.id, exec_at: row.exec_at }, 201);
});
