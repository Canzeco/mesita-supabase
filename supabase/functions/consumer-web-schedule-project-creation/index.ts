// Supabase Edge Function — consumer-web-schedule-project-creation (consumer caller)
//
// COMPAT SHIM (MESITA-127): the staggered creation queue is gone
// (scheduled_project_creations table + pg_cron poller + the
// supabase-cron-run-project-creations EF were all dropped). Creation is now
// immediate for every caller; only enrichment is scheduled (the seeded
// place_research row drives the cron Enricher pipeline).
//
// This slug survives ONLY because the deployed consumer app still calls it
// (half-rename lesson: never delete the old slug until the app flips). It runs
// the same inline create as consumer-web-create-project and keeps the old
// response keys (`scheduled_id`, `exec_at`) so the stale client stays happy.
// `exec_at` in the body is accepted and ignored — there is no deferral anymore.
//
// DELETE this EF once the consumer app is verified on consumer-web-create-project.
//
// Local:  supabase functions serve consumer-web-schedule-project-creation
// Deploy: supabase functions deploy consumer-web-schedule-project-creation

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { createMinimalPlace } from "../_shared/create-place.ts";

type Body = { placeId?: string; googlePlaceId?: string; exec_at?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Authenticate the consumer.
  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;

  // Parse input. The old client sends the Google Place ID under `placeId`.
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const googlePlaceId = (bodyRes.body.placeId ?? bodyRes.body.googlePlaceId ?? "").toString().trim();
  if (!googlePlaceId) return json({ ok: false, error: "placeId is required" }, 400);

  const admin = adminClient(env);

  const created = await createMinimalPlace({
    admin,
    callerName: "consumer-web-schedule-project-creation",
    googlePlaceId,
    dedupeError: "This place is already on Mesita.",
  });
  if (!created.ok) return json(created.body, created.status);

  // Old response contract: the stale client types `{ scheduled_id, exec_at }`
  // (it reads neither — the Add flow is fire-and-forget — but keep the keys).
  return json(
    {
      ok: true,
      scheduled_id: created.place.id,
      exec_at: new Date().toISOString(),
      place: created.place,
      enrichment: created.enrichment,
    },
    201,
  );
});
