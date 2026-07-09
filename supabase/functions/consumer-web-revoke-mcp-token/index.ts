// Supabase Edge Function — consumer-web-revoke-mcp-token (natural caller)
//
// Authenticated. Soft-revokes one of the caller's MCP tokens.
//
// Body: { token_id: uuid }
//
// Deploy: supabase functions deploy consumer-web-revoke-mcp-token

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";

type Body = { token_id?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const consumerId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const tokenId = bodyRes.body.token_id;
  if (!tokenId || typeof tokenId !== "string") {
    return json({ ok: false, error: "token_id required" }, 400);
  }

  const admin = adminClient(envRes.env);
  const { data, error } = await admin
    .from("consumer_mcp_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("consumer_id", consumerId)
    .is("revoked_at", null)
    .select("id, token_prefix, label, revoked_at")
    .maybeSingle();

  if (error) return json({ ok: false, error: error.message }, 500);
  if (!data) {
    return json({ ok: false, error: "Token not found or already revoked" }, 404);
  }
  return json({ ok: true, token: data });
});
