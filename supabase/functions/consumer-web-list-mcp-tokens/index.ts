// Supabase Edge Function — consumer-web-list-mcp-tokens (natural caller)
//
// Authenticated. Lists the caller's MCP tokens (prefix + metadata only —
// never the plaintext).
//
// Deploy: supabase functions deploy consumer-web-list-mcp-tokens

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const consumerId = authRes.user.id;

  const admin = adminClient(envRes.env);
  const { data, error } = await admin
    .from("consumer_mcp_tokens")
    .select(
      "id, token_prefix, label, created_at, last_used_at, revoked_at",
    )
    .eq("consumer_id", consumerId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, tokens: data ?? [] });
});
