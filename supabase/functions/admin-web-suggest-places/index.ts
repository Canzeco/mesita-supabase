// Supabase Edge Function — admin-web-suggest-places (natural caller)
//
// Google Places autocomplete for the admin console's Create Single Unit
// flow. Gates the request to super_admins, then runs the shared
// Google + Mesita merge in-process (_shared/suggest-places.ts; the
// enricher suggest-places HTTP hop was absorbed in MESITA-55) for the
// existence + ownership flags on each prediction.
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";
import { suggestPlaces } from "../_shared/suggest-places.ts";

type Body = { input?: string; sessionToken?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;
  const admin = adminClient(env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  return await suggestPlaces(env, "admin-web-suggest-places", {
    input: body.input,
    sessionToken: body.sessionToken,
    // Admin surface — no self/other split; claimed rows show as _other.
    callerUserId: null,
    sourcingChannel: "admin_search",
  });
});
