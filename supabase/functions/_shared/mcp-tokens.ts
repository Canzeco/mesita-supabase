// Consumer MCP token helpers — mint, hash, resolve bearer → consumer_id.
// Used by consumer-web-*-mcp-token EFs and the consumer-mcp MCP endpoint.
// Web Crypto only (same pattern as otp.ts / store-place-images.ts).

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { json } from "./http.ts";

export const MCP_TOKEN_PREFIX = "mesita_mcp_";

function bytesToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashMcpToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plaintext),
  );
  return bytesToHex(digest);
}

/** Mint a new plaintext token. Caller must hash + persist before returning. */
export async function mintMcpTokenPlaintext(): Promise<{
  plaintext: string;
  prefix: string;
  hash: string;
}> {
  const secret = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const plaintext = `${MCP_TOKEN_PREFIX}${secret}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 16),
    hash: await hashMcpToken(plaintext),
  };
}

export type McpTokenRow = {
  id: string;
  consumer_id: string;
  token_prefix: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/**
 * Resolve Authorization: Bearer mesita_mcp_… → active token row.
 * Touches last_used_at best-effort. Returns 401 Response on failure.
 */
export async function resolveMcpBearer(
  req: Request,
  admin: SupabaseClient,
): Promise<
  | { ok: true; token: McpTokenRow }
  | { ok: false; response: Response }
> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      response: json({ ok: false, error: "Missing bearer token" }, 401),
    };
  }
  const plaintext = authHeader.slice("Bearer ".length).trim();
  if (!plaintext.startsWith(MCP_TOKEN_PREFIX) || plaintext.length < 24) {
    return {
      ok: false,
      response: json({ ok: false, error: "Invalid MCP token" }, 401),
    };
  }

  const tokenHash = await hashMcpToken(plaintext);
  const { data, error } = await admin
    .from("consumer_mcp_tokens")
    .select(
      "id, consumer_id, token_prefix, label, created_at, last_used_at, revoked_at",
    )
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      response: json({ ok: false, error: `token_lookup: ${error.message}` }, 500),
    };
  }
  if (!data) {
    return {
      ok: false,
      response: json({ ok: false, error: "Invalid or revoked MCP token" }, 401),
    };
  }

  // Best-effort last_used — never block the tool call on this write.
  void admin
    .from("consumer_mcp_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  return { ok: true, token: data as McpTokenRow };
}
