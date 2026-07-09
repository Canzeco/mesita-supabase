// Supabase Edge Function — consumer-web-create-place (LIVE consumer create path)
//
// The signed-in consumer passes a Google Places `googlePlaceId` (from the
// Search → Add flow). The place is created IMMEDIATELY — same shared core as
// the admin and business creates — and only deep enrichment stays async:
//   1. authenticate the consumer,
//   2. createMinimalPlace (_shared/create-place.ts): dedupe → Google spine →
//      save 'generating' row → seed place_research (the supabase-cron-enrich-place-*
//      poller takes it from there).
//
// Replaces the queued flow (consumer-web-schedule-project-creation →
// scheduled_project_creations → cron): the place row must exist the moment the
// consumer adds it; enrichment is the only scheduled part (MESITA-128).
//
// Local:  supabase functions serve consumer-web-create-place
// Deploy: supabase functions deploy consumer-web-create-place

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { createMinimalPlace } from "../_shared/create-place.ts";
import { consumeConsumerCreateQuota } from "../_shared/create-quota.ts";

// `googlePlaceId` is the canonical key; legacy `placeId` accepted until every
// client sends the new key (same contract as business-web-create-project).
type Body = { googlePlaceId?: string; placeId?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Authenticate the consumer.
  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;

  // Parse input.
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const googlePlaceId = (bodyRes.body.googlePlaceId ?? bodyRes.body.placeId ?? "")
    .toString()
    .trim();
  if (!googlePlaceId) {
    return json({ ok: false, error: "googlePlaceId is required" }, 400);
  }

  const admin = adminClient(env);

  // Per-consumer rolling 24 h quota — every attempt is metered BEFORE any
  // Google spend (create-quota.ts has the abuse rationale).
  const quota = await consumeConsumerCreateQuota(
    admin,
    authRes.user.id,
    googlePlaceId,
    "consumer-web-create-place",
  );
  if (!quota.ok) return quota.response;

  const created = await createMinimalPlace({
    admin,
    callerName: "consumer-web-create-place",
    googlePlaceId,
    dedupeError: "This place is already on Mesita.",
  });
  if (!created.ok) return json(created.body, created.status);

  return json({ ok: true, place: created.place, enrichment: created.enrichment }, 201);
});
