// Shared identity-check handler behind the per-caller *-get-identity EFs
// (admin-web-get-identity, business-web-get-identity). Split out of the old
// multi-caller auth-get-identity EF (MESITA-54): the endpoint name IS the
// ACL, so each app shell gets its own thin door over this one handler.
//
// Returns the caller's email + whether their email is in
// public.super_admins. The shell uses it to either render the admin surface
// or a friendly "your account isn't on the super-admin list" empty state.
//
// This handler only authenticates — it doesn't authorize. A non-allowlisted
// caller still gets a 200 with `isSuperAdmin: false`; the shell handles the
// rendering. The privileged EFs are the real auth gate.

import { json } from "./http.ts";
import { adminClient, checkSuperAdmin, getAuthedUser, readEFEnv } from "./auth.ts";

export async function handleGetIdentity(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);
  const isSuperAdmin = await checkSuperAdmin(admin, authRes.user);

  return json({ ok: true, email: authRes.user.email, isSuperAdmin });
}
