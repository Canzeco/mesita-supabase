// Supabase Edge Function — admin-web-get-memo-config
//
// Naming: caller-verb-words. Caller = admin, verb = get, words = memo-config.
//
// Returns Memo's persona + model config from the public.app_settings singleton
// for the admin console's Memo Config page. Memo is the consumer AI concierge
// (consumer-web-ask-memo); see 20260707220000_memo_config.sql for the columns.
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
    .select(
      "memo_greeting, memo_instructions, memo_provider, memo_openai_model, memo_web_grounding, memo_perplexity_model, updated_at",
    )
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    return json({ ok: false, error: `memo_config_read: ${error.message}` }, 500);
  }
  if (!data) {
    return json({ ok: false, error: "app_settings missing" }, 500);
  }

  return json({
    ok: true,
    greeting: data.memo_greeting,
    instructions: data.memo_instructions,
    provider: data.memo_provider,
    openaiModel: data.memo_openai_model,
    webGrounding: data.memo_web_grounding,
    perplexityModel: data.memo_perplexity_model,
    updatedAt: data.updated_at,
  });
});
