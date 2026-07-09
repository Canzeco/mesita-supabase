// Supabase Edge Function — admin-web-get-sourcing-config
//
// Naming: caller-verb-words. Caller = admin, verb = get, words = sourcing-config.
//
// Returns the place-sourcing policy from the public.app_settings singleton for
// the admin console's Sourcing Config page. The policy decides, per sourcing
// channel (admin_add / admin_search / business_add / consumer_add / memo_search),
// which place families are eligible to enter Mesita and the Google quality bar
// (min rating + min review count). See 20260708120000_sourcing_config.sql.
//
// Auth: caller's JWT email must be in public.super_admins.

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
    .from("app_settings")
    .select("sourcing_config, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    return json({ ok: false, error: `sourcing_config_read: ${error.message}` }, 500);
  }
  if (!data) {
    return json({ ok: false, error: "app_settings missing" }, 500);
  }

  return json({
    ok: true,
    config: data.sourcing_config,
    updatedAt: data.updated_at,
  });
});
