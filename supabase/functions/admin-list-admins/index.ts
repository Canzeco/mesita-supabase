// Supabase Edge Function — admin-list-admins
//
// Lists the super-admin allowlist (public.super_admins). Read-only.
// Caller must already be a super-admin. Powers the "Add/remove admins"
// card in the admin app's Admin Configuration page.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

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

  const { data, error } = await admin
    .from("super_admins")
    .select("email, note, created_at, added_by")
    .order("created_at", { ascending: true });
  if (error) {
    return json({ ok: false, error: `list_failed: ${error.message}` }, 500);
  }

  return json({
    ok: true,
    admins: data ?? [],
    self: authRes.user.emailLower,
  });
});
