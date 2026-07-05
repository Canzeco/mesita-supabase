// Supabase Edge Function — admin-web-create-project (admin caller / LIVE admin create path)
//
// The admin-app equivalent of business-web-create-project: an admin operator
// passes a Google Places `placeId` and gets back a MINIMAL 'generating' place;
// deep enrichment then runs ASYNC in the Enricher pipeline
// (supabase-cron-enrich-place-*). Core: createMinimalPlace
// (_shared/create-place.ts): dedupe → Google spine → save 'generating' row →
// seed place_research.
//
// Roles are simple now: admins create from the admin app via THIS function;
// businesses create from the business app via business-web-create-project. (There is
// no "super-admin operates the business app" path anymore.)
//
// Gating: operator JWT → the admin allowlist (requireSuperAdmin checks the
// public.super_admins table — that table IS the admin allowlist; this is the
// same gate every other admin-* EF uses).
//
// Difference vs business-web-create-project: NO businesses upsert — an admin creates an
// UNOWNED listing (listing_type='web'); ownership only ever lands when a business
// claims it and admin-web-decide-verification approves.
//
// Local:  supabase functions serve admin-web-create-project
// Deploy: supabase functions deploy admin-web-create-project

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv, requireSuperAdmin } from "../_shared/auth.ts";
import { createMinimalPlace } from "../_shared/create-place.ts";

type Body = { placeId?: string };

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
  const guard = await requireSuperAdmin(admin, authRes.user, "Only admins can create units.");
  if (!guard.ok) return guard.response;

  // Parse input.
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  const created = await createMinimalPlace({
    env,
    admin,
    callerName: "admin-web-create-project",
    googlePlaceId: placeId,
  });
  if (!created.ok) return json(created.body, created.status);

  return json({ ok: true, place: created.place, enrichment: created.enrichment }, 201);
});
