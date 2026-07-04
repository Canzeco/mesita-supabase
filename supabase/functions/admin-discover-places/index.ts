// Supabase Edge Function — admin-discover-places (natural caller)
//
// Thin facade for the admin bulk-search UI. Gates the request to
// super_admins, then forwards the query batch to the enricher-discover-places
// artificial caller for the actual Google fan-out + Mesita enrichment.
//
// Auth: caller's JWT email must be in public.super_admins. verify_jwt = true
// at the gateway gates the request to a real session before we even see it.
//
// Wire status follows the standard admin EF contract: 403 when the caller
// is not on public.super_admins. efInvoke surfaces the error body to the UI.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

type RequestBody = {
  queries?: string[];
  regionCode?: string;
  maxResultsPerQuery?: number;
};

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

  const bodyRes = await readJson<RequestBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const result = await invokeArtificialCaller(
    env,
    "admin-discover-places",
    "enricher-discover-places",
    body,
  );
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 502);
  }
  return json(result.data);
});
