// Supabase Edge Function — admin-web-update-memo-config
//
// Naming: caller-verb-words. Caller = admin, verb = update, words = memo-config.
//
// Partial-update of Memo's persona + model config on the public.app_settings
// singleton, written from the admin console's Memo Config page. Each field is
// optional; only keys present in the body are written. Memo is the consumer AI
// concierge (consumer-web-ask-memo) — memo_instructions is read live as its
// system prompt; the model knobs are staged for the Memo model rebuild.
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Body = {
  greeting?: string;
  instructions?: string;
  provider?: string;
  openaiModel?: string;
  webGrounding?: boolean;
  perplexityModel?: string;
};

// Keep these in lock-step with the admin picker (Memo Config actions.ts).
const PROVIDERS = new Set(["openai"]);
const OPENAI_MODELS = new Set(["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"]);
const PERPLEXITY_MODELS = new Set([
  "sonar",
  "sonar-pro",
  "sonar-reasoning",
  "sonar-reasoning-pro",
]);

const MAX_GREETING = 1000;
const MAX_INSTRUCTIONS = 8000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const patch: Record<string, unknown> = {};

  if (body.greeting !== undefined) {
    if (typeof body.greeting !== "string" || body.greeting.trim().length === 0) {
      return json({ ok: false, error: "greeting must be a non-empty string" }, 400);
    }
    if (body.greeting.length > MAX_GREETING) {
      return json({ ok: false, error: `greeting must be ≤ ${MAX_GREETING} chars` }, 400);
    }
    patch.memo_greeting = body.greeting;
  }

  if (body.instructions !== undefined) {
    if (
      typeof body.instructions !== "string" ||
      body.instructions.trim().length === 0
    ) {
      return json({ ok: false, error: "instructions must be a non-empty string" }, 400);
    }
    if (body.instructions.length > MAX_INSTRUCTIONS) {
      return json({ ok: false, error: `instructions must be ≤ ${MAX_INSTRUCTIONS} chars` }, 400);
    }
    patch.memo_instructions = body.instructions;
  }

  if (body.provider !== undefined) {
    if (typeof body.provider !== "string" || !PROVIDERS.has(body.provider)) {
      return json({ ok: false, error: "provider must be openai" }, 400);
    }
    patch.memo_provider = body.provider;
  }

  if (body.openaiModel !== undefined) {
    if (typeof body.openaiModel !== "string" || !OPENAI_MODELS.has(body.openaiModel)) {
      return json({ ok: false, error: "openaiModel is not a supported model" }, 400);
    }
    patch.memo_openai_model = body.openaiModel;
  }

  if (body.webGrounding !== undefined) {
    if (typeof body.webGrounding !== "boolean") {
      return json({ ok: false, error: "webGrounding must be a boolean" }, 400);
    }
    patch.memo_web_grounding = body.webGrounding;
  }

  if (body.perplexityModel !== undefined) {
    if (
      typeof body.perplexityModel !== "string" ||
      !PERPLEXITY_MODELS.has(body.perplexityModel)
    ) {
      return json({ ok: false, error: "perplexityModel is not a supported model" }, 400);
    }
    patch.memo_perplexity_model = body.perplexityModel;
  }

  if (Object.keys(patch).length === 0) {
    return json({ ok: false, error: "Nothing to update" }, 400);
  }
  patch.updated_by = userId;

  const { data, error } = await admin
    .from("app_settings")
    .update(patch)
    .eq("id", 1)
    .select(
      "memo_greeting, memo_instructions, memo_provider, memo_openai_model, memo_web_grounding, memo_perplexity_model, updated_at",
    )
    .single();
  if (error) {
    return json({ ok: false, error: `memo_config_update: ${error.message}` }, 500);
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
