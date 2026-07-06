// Shared helpers for invoking *artificial-caller* EFs from *natural-caller*
// EFs (and authenticating those calls on the receiving end).
//
// Background: natural callers (admin/business/consumer/staff/waiter) are
// invoked by web clients and authenticate end users. Artificial callers
// (recommender/enricher/…) are reusable internal services with no end
// user — they exist so multiple natural callers can share expensive
// pipelines (RAG, Google Places, Enricher Storage IO) without duplicating
// hundreds of lines of code per natural EF.
//
// Wire protocol between the two:
//   1. The natural caller sends `Authorization: Bearer <a service_role JWT>`
//      and `X-Internal-Caller: <natural-EF-name>` to the artificial caller.
//   2. The artificial caller has `verify_jwt = true` in supabase/config.toml,
//      so Supabase's gateway VERIFIES THE JWT SIGNATURE before the function
//      runs — a forged/unsigned token never reaches our code.
//   3. Inside the artificial caller, `requireInternalCaller(req, env)` decodes
//      the (already-signature-verified) JWT and requires `role === 'service_role'`.
//      Anything else gets a 403.
//
// This decouples internal auth from the *exact* SUPABASE_SERVICE_ROLE_KEY
// string: any correctly-signed token bearing role=service_role passes, so
// key rotation no longer requires a lockstep redeploy of every EF.
//
// ⚠️ SAFETY INVARIANT — READ BEFORE REUSING requireInternalCaller ⚠️
// This role-claim check is safe ONLY because every EF that calls it is
// `verify_jwt = true`. Under verify_jwt=true the Supabase gateway validates
// the JWT signature (against the project's JWT secret) BEFORE the function
// runs, so by the time we decode the payload here it is already authentic.
// It MUST NEVER be used on a `verify_jwt = false` EF: there the gateway does
// no verification, and an attacker could hand-craft an UNSIGNED JWT whose
// payload literally says {"role":"service_role"} — this function would decode
// it and wave it through. verify_jwt=true is the load-bearing half of the
// check; the decode below trusts, it does not verify.

import type { EFEnv } from "./auth.ts";
import { json } from "./http.ts";
import { timingSafeEqual } from "./timing-safe-equal.ts";

// Base64url-decode + JSON.parse the JWT payload (middle segment). Returns null
// on any malformed input — callers treat null as "reject". We do NOT verify the
// signature here; the gateway already did (see the invariant above).
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    const payload = JSON.parse(json);
    return (payload && typeof payload === "object") ? payload : null;
  } catch {
    return null;
  }
}

// Verifies that a request was made by another EF (or the pg_cron poller) with a
// service-role credential. Use this at the top of every artificial-caller EF —
// and ONLY on EFs that are `verify_jwt = true` (see the invariant above).
//
// Two accepted bearer shapes (the platform migrated EF env to the NEW API
// keys on 2026-07-05, so both circulate):
//   1. Legacy service_role JWT — gateway-verified signature; we decode the
//      payload and require role === 'service_role'. (n8n creds, Vault
//      scheduler secret, dashboard key.)
//   2. New secret API key (sb_secret_…) — this is what the platform now
//      injects as SUPABASE_SERVICE_ROLE_KEY into EF env, so it's what
//      invokeArtificialCaller sends. Not a JWT, so no payload to check;
//      instead we constant-time compare against our own env.serviceKey
//      (both sides read the same injected secret). The publishable key
//      (sb_publishable_…) never matches.
export function requireInternalCaller(
  req: Request,
  env: EFEnv,
):
  | { ok: true; callerName: string }
  | { ok: false; response: Response } {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      response: json({ ok: false, error: "Internal call requires bearer" }, 401),
    };
  }
  const token = authHeader.slice("Bearer ".length).trim();
  const payload = decodeJwtPayload(token);
  const jwtOk = !!payload && payload.role === "service_role";
  const secretKeyOk = !payload && timingSafeEqual(token, env.serviceKey);
  if (!jwtOk && !secretKeyOk) {
    return {
      ok: false,
      response: json({ ok: false, error: "Internal call rejected" }, 403),
    };
  }
  const callerName = (req.headers.get("X-Internal-Caller") ?? "unknown").slice(0, 64);
  return { ok: true, callerName };
}

// Invokes an artificial-caller EF from a natural-caller EF. Returns the
// parsed body verbatim — the artificial caller's response shape is the
// natural caller's response shape minus auth/shaping concerns.
//
// We use the gateway URL (env.url + "/functions/v1/<name>") directly
// instead of supabase-js's functions.invoke so we can pass through arbitrary
// headers without supabase-js layering its own auth on top.
export async function invokeArtificialCaller<T = unknown>(
  env: EFEnv,
  callerName: string, // who the natural caller is, e.g. "consumer-web-recommend-swipe"
  artificialName: string, // who we're calling, e.g. "supabase-edgefunc-store-place-images"
  body: unknown,
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: string; status: number }
> {
  const url = `${env.url}/functions/v1/${artificialName}`;
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.serviceKey}`,
        "Content-Type": "application/json",
        "X-Internal-Caller": callerName,
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `network error calling ${artificialName}`,
      status: 0,
    };
  }
  let parsed: unknown;
  try {
    parsed = await r.json();
  } catch {
    return {
      ok: false,
      error: `${artificialName} returned non-JSON (HTTP ${r.status})`,
      status: r.status,
    };
  }
  if (!r.ok) {
    const msg =
      (parsed as { error?: string } | null)?.error ??
      `${artificialName} returned HTTP ${r.status}`;
    return { ok: false, error: msg, status: r.status };
  }
  return { ok: true, data: parsed as T };
}
