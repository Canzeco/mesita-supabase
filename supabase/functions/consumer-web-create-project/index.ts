// Supabase Edge Function — consumer-web-create-project (consumer caller)
//
// The consumer "Add to Mesita" flow: creates the place IMMEDIATELY via the
// shared createMinimalPlace core (dedupe → Google spine → save 'generating'
// rows → seed place_research), exactly like admin-web-create-unit and
// business-web-create-project. Enrichment stays async: the seeded
// place_research row is picked up by the cron-driven Enricher pipeline
// (run-place-enrichment-stages), and the place flips content_status
// 'generating' → 'ready' when it finishes.
//
// Replaces the queued path (consumer-web-schedule-project-creation →
// scheduled_project_creations → pg_cron → supabase-cron-run-project-creations),
// removed in MESITA-127: creation is now inline for every caller; only
// enrichment is scheduled.
//
// Like the admin path, this creates an UNOWNED listing (listing_type='web' is
// set by savePlaceData); there is NO accounts upsert here.
//
// Gating: a signed-in consumer session (getAuthedUser). The client never
// touches the DB — the EF writes with the service-role key.
//
// Local:  supabase functions serve consumer-web-create-project
// Deploy: supabase functions deploy consumer-web-create-project

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { createMinimalPlace } from "../_shared/create-place.ts";

// `googlePlaceId` per MESITA-51 addendum 9 (`placeId` is reserved for
// place-row UUIDs platform-wide). The legacy `placeId` key is accepted as a
// fallback so the old client body shape keeps working.
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
  const googlePlaceId = (bodyRes.body.googlePlaceId ?? bodyRes.body.placeId ?? "").toString().trim();
  if (!googlePlaceId) return json({ ok: false, error: "googlePlaceId is required" }, 400);

  const admin = adminClient(env);

  const created = await createMinimalPlace({
    admin,
    callerName: "consumer-web-create-project",
    googlePlaceId,
    dedupeError: "This place is already on Mesita.",
  });
  if (!created.ok) return json(created.body, created.status);

  return json({ ok: true, place: created.place, enrichment: created.enrichment }, 201);
});
