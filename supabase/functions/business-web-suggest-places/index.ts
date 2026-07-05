// Supabase Edge Function — business-web-suggest-places (natural caller)
//
// Thin facade for the business /add page picker. Resolves the caller's
// user id (so the suggest engine can flag verified_partner_self vs _other
// on already-owned places) and runs the shared Google + Mesita merge
// in-process (_shared/suggest-places.ts; the old enricher suggest-places
// HTTP hop was absorbed in MESITA-55).
//
// JWT-protected: clients must send the Supabase anon JWT in Authorization.
// Anonymous (anon key only, no user session) calls still get useful
// predictions — ownership flagging just degrades to "_other" because
// there's no caller to compare against.
//
// Local:  supabase functions serve business-web-suggest-places
// Deploy: supabase functions deploy business-web-suggest-places

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { getOptionalAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { suggestPlaces } from "../_shared/suggest-places.ts";

type Body = { input?: string; sessionToken?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  // Resolve caller user id from the bearer (if present). The suggest
  // engine uses this to mark verified_partner_self vs _other on
  // Mesita-side matches. RLS-aware user client; anonymous degrades to
  // "_other".
  const { user } = await getOptionalAuthedUser(req, env);
  const callerUserId = user?.id ?? null;

  return await suggestPlaces(env, "business-web-suggest-places", {
    input: body.input,
    sessionToken: body.sessionToken,
    callerUserId,
  });
});
