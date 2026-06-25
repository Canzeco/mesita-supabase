// Supabase Edge Function — admin-revoke-admin
//
// Removes an email from the super-admin allowlist (public.super_admins).
// Caller must already be a super-admin. Two safety guards: a caller
// cannot revoke their own access (no self-lockout), and the last
// remaining admin cannot be removed (no empty allowlist). Revoking an
// email that isn't on the list is a no-op success.

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

  // Guard 1: no self-lockout.
  if (email === authRes.user.emailLower) {
    return json(
      { ok: false, error: "You can't remove your own admin access." },
      400,
    );
  }

  // Guard 2: never empty the allowlist.
  const { count, error: countErr } = await admin
    .from("super_admins")
    .select("email", { count: "exact", head: true });
  if (countErr) {
    return json({ ok: false, error: `count_failed: ${countErr.message}` }, 500);
  }
  if ((count ?? 0) <= 1) {
    return json(
      { ok: false, error: "Can't remove the last remaining admin." },
      400,
    );
  }

  const { data, error } = await admin
    .from("super_admins")
    .delete()
    .eq("email", email)
    .select("email");
  if (error) {
    return json({ ok: false, error: `revoke_failed: ${error.message}` }, 500);
  }

  return json({ ok: true, removed: (data ?? []).length });
});
