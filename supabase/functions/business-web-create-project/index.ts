// Supabase Edge Function — business-web-create-project (LIVE business create path)
//
// The signed-in business passes a Google Places `googlePlaceId`. ASYNC create —
// a MINIMAL 'generating' place is returned immediately and deep enrichment runs
// in the Enricher pipeline (supabase-cron-enrich-place-*):
//   1. authenticate the business + upsert its accounts row (ownership scaffolding),
//   2. createMinimalPlace (_shared/create-place.ts): dedupe → Google spine →
//      save 'generating' row → seed place_research.
//
// Intentionally NO project_members insert — the caller becomes owner only when
// admin-web-decide-verification approves the ownership claim; until then the place
// is publicly listed but unowned.
//
// Local:  supabase functions serve business-web-create-project
// Deploy: supabase functions deploy business-web-create-project

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { createMinimalPlace } from "../_shared/create-place.ts";

// `googlePlaceId` is the canonical key (Google Place ID). Legacy `placeId`
// is accepted as a fallback until every client sends the new key — it was
// semantically overloaded (Google ID here, place-row UUID on the
// readPlaceIdAlias endpoints), so the new slug disambiguates.
type Body = { googlePlaceId?: string; placeId?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Authenticate the business.
  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;
  const userEmail = authRes.user.email;

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

  // Ownership scaffolding: upsert the signed-in business so its row exists for
  // any later ownership claim. NO project_members insert — ownership lands at
  // admin-web-decide-verification.
  const { error: businessError } = await admin
    .from("accounts")
    .upsert({ id: userId, email: userEmail }, { onConflict: "id" });
  if (businessError) {
    return json({ ok: false, error: `business_upsert: ${businessError.message}` }, 500);
  }

  const created = await createMinimalPlace({
    env,
    admin,
    callerName: "business-web-create-project",
    googlePlaceId,
    dedupeError:
      "This place is already on Mesita. If you manage it, contact support to claim ownership.",
  });
  if (!created.ok) return json(created.body, created.status);

  return json({ ok: true, place: created.place, enrichment: created.enrichment }, 201);
});
