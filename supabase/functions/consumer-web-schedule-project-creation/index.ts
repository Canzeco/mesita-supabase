// Supabase Edge Function — consumer-web-schedule-project-creation (consumer caller)
//
// COMPATIBILITY ALIAS of consumer-web-create-place (MESITA-128) — the slug the
// previously-deployed consumer app still calls. Places are created IMMEDIATELY
// now (Pato directive: only enrichment is scheduled); the queue this EF used to
// feed (scheduled_project_creations + its cron) is retired.
//
// Legacy response semantics preserved for the deployed app:
//   • success → 201 { ok, scheduled_id: <place id>, exec_at: <now>, place }
//   • duplicate → 201 with the EXISTING place id (the old queue accepted
//     duplicates silently and the cron dropped them later — the alias must not
//     start erroring on the deployed Add button).
//   • exec_at input is accepted and ignored (deferred creation retired).
//
// New clients call consumer-web-create-place instead. Delete this alias once
// every deployed client has flipped.
//
// Local:  supabase functions serve consumer-web-schedule-project-creation
// Deploy: supabase functions deploy consumer-web-schedule-project-creation

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import {
  CONSUMER_PLACE_CREATE_QUOTA,
  createMinimalPlace,
} from "../_shared/create-place.ts";

type Body = { googlePlaceId?: string; placeId?: string; exec_at?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Authenticate the consumer.
  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;

  // Parse input (legacy body key is `placeId`; exec_at ignored).
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const googlePlaceId = (bodyRes.body.googlePlaceId ?? bodyRes.body.placeId ?? "")
    .toString()
    .trim();
  if (!googlePlaceId) return json({ ok: false, error: "placeId is required" }, 400);

  const admin = adminClient(env);

  const created = await createMinimalPlace({
    admin,
    callerName: "consumer-web-schedule-project-creation",
    googlePlaceId,
    dedupeError: "This place is already on Mesita.",
    // Rolling 24h per-consumer bound — every create burns real Google +
    // Enricher budget, so scripted unlimited adds must not be possible.
    quota: { userId: authRes.user.id, ...CONSUMER_PLACE_CREATE_QUOTA },
  });

  const nowIso = new Date().toISOString();
  if (!created.ok) {
    // Legacy silent-dedupe: a duplicate Add reads as success, pointing at the
    // existing place. Everything else is a real error.
    if (created.body.code === "place_already_exists") {
      const existing = created.body.existing as { id?: string } | undefined;
      return json({
        ok: true,
        scheduled_id: existing?.id ?? googlePlaceId,
        exec_at: nowIso,
        already_exists: true,
        place: existing ?? null,
      }, 201);
    }
    return json(created.body, created.status);
  }

  return json({
    ok: true,
    scheduled_id: created.place.id,
    exec_at: nowIso,
    place: created.place,
    enrichment: created.enrichment,
  }, 201);
});
