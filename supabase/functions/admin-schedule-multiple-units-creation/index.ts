// Supabase Edge Function — admin-schedule-multiple-units-creation (admin caller)
//
// Bulk staggered create: takes an array of Google Places `placeIds` and enqueues
// one scheduled_project_creations row per id with exec_at = baseAt + i*staggerSeconds,
// so the poller drips them out over time instead of hammering the create pipeline
// (and the underlying Google/Firecrawl/OpenAI budgets) all at once. A single bulk
// INSERT — not N internal calls.
//
// Caps at 1000 ids; anything beyond is dropped and logged (truncated flag in the
// response so the caller can re-submit the tail).
//
// Gating: operator JWT → the admin allowlist (requireSuperAdmin).
//
// Local:  supabase functions serve admin-schedule-multiple-units-creation
// Deploy: supabase functions deploy admin-schedule-multiple-units-creation

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv, requireSuperAdmin } from "../_shared/auth.ts";

type Body = { placeIds?: unknown; baseAt?: string; staggerSeconds?: number };

const MAX_ROWS = 1000;

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

  // placeIds — normalize, trim, drop blanks + dedupe (preserving order).
  const raw = Array.isArray(bodyRes.body.placeIds) ? bodyRes.body.placeIds : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const v of raw) {
    const id = (v ?? "").toString().trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) return json({ ok: false, error: "placeIds must be a non-empty array" }, 400);

  // Cap + log truncation.
  const truncated = ids.length > MAX_ROWS;
  if (truncated) {
    console.warn(
      `admin-schedule-multiple-units-creation: ${ids.length} ids submitted, truncating to ${MAX_ROWS}`,
    );
  }
  const kept = ids.slice(0, MAX_ROWS);

  // baseAt optional — default now(). When provided it must parse.
  let baseMs = Date.now();
  if (bodyRes.body.baseAt != null) {
    const ms = Date.parse(bodyRes.body.baseAt);
    if (Number.isNaN(ms)) return json({ ok: false, error: "baseAt must be an ISO timestamp" }, 400);
    baseMs = ms;
  }

  // staggerSeconds optional — default 30, clamped to [0, 3600].
  let stagger = 30;
  if (bodyRes.body.staggerSeconds != null) {
    const n = Number(bodyRes.body.staggerSeconds);
    if (!Number.isFinite(n) || n < 0) {
      return json({ ok: false, error: "staggerSeconds must be a non-negative number" }, 400);
    }
    stagger = Math.min(3600, Math.trunc(n));
  }

  // Build the rows: exec_at = base + i*stagger.
  const rows = kept.map((placeId, i) => ({
    place_id: placeId,
    exec_at: new Date(baseMs + i * stagger * 1000).toISOString(),
    created_by: createdBy,
  }));

  // Single bulk insert.
  const { data: inserted, error } = await admin
    .from("scheduled_project_creations")
    .insert(rows)
    .select("id, place_id, exec_at");
  if (error || !inserted) {
    return json({ ok: false, error: `schedule_bulk_insert: ${error?.message ?? "no rows"}` }, 500);
  }

  const first = inserted[0]?.exec_at ?? null;
  const last = inserted[inserted.length - 1]?.exec_at ?? null;

  return json(
    {
      ok: true,
      scheduled: inserted.length,
      submitted: ids.length,
      truncated,
      stagger_seconds: stagger,
      window: { first_exec_at: first, last_exec_at: last },
      items: inserted,
    },
    201,
  );
});
