// Supabase Edge Function — admin-web-revoke-admin
//
// Removes an email from the super-admin allowlist (public.super_admins).
// Caller must already be a super-admin. Two safety guards: a caller
// cannot revoke their own access (no self-lockout, enforced here), and the
// last remaining admin cannot be removed (no empty allowlist, enforced
// atomically by the security-definer public.admin_revoke_admin function so
// concurrent revokes can't race past it). Revoking an email that isn't on
// the list is a no-op success.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Body = { email?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);

  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;

  const email = (bodyRes.body.email ?? "").trim().toLowerCase();
  if (!email) {
    return json({ ok: false, error: "An email is required" }, 400);
  }

  // Guard: no self-lockout. (The "never empty the allowlist" guard lives in
  // the SQL function below so it's atomic under concurrent revokes.)
  if (email === authRes.user.emailLower) {
    return json(
      { ok: false, error: "You can't remove your own admin access." },
      400,
    );
  }

  // Atomic count-check + delete behind a transaction advisory lock.
  const { data, error } = await admin.rpc("admin_revoke_admin", {
    p_email: email,
  });
  if (error) {
    if ((error.message ?? "").includes("last_admin")) {
      return json(
        { ok: false, error: "Can't remove the last remaining admin." },
        400,
      );
    }
    return json({ ok: false, error: `revoke_failed: ${error.message}` }, 500);
  }

  return json({ ok: true, removed: typeof data === "number" ? data : 0 });
});
