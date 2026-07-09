// Supabase Edge Function — admin-web-update-sourcing-config
//
// Naming: caller-verb-words. Caller = admin, verb = update, words = sourcing-config.
//
// Writes the place-sourcing policy on the public.app_settings singleton from the
// admin console's Sourcing Config page. The body carries a partial config keyed by
// channel; only known channels are merged, each fully validated. Unknown channels
// and future keys already on the row are preserved. See the getter + the
// 20260708120000_sourcing_config.sql migration for the shape.
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

// Keep these in lock-step with the admin catalog (Sourcing Config catalog.ts).
const CHANNELS = new Set([
  "admin_add",
  "admin_search",
  "business_add",
  "consumer_add",
  "memo_search",
]);
const FAMILIES = new Set([
  "restaurants",
  "bars_nightlife",
  "cafes_bakeries",
  "wellness_spa",
  "experiences",
  "culture_arts",
]);

const MAX_RATING = 5;
const MAX_REVIEWS = 1_000_000;

type ChannelPolicy = {
  enabled: boolean;
  families: string[];
  minRating: number;
  minReviews: number;
};

// Coerce + clamp one channel's policy. Returns an error string on invalid input.
function normalizeChannel(
  key: string,
  raw: unknown,
): { ok: true; value: ChannelPolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: `${key}: policy must be an object` };
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.enabled !== "boolean") {
    return { ok: false, error: `${key}.enabled must be a boolean` };
  }

  if (!Array.isArray(p.families)) {
    return { ok: false, error: `${key}.families must be an array` };
  }
  const families: string[] = [];
  for (const f of p.families) {
    if (typeof f !== "string" || !FAMILIES.has(f)) {
      return { ok: false, error: `${key}.families has unknown family "${String(f)}"` };
    }
    if (!families.includes(f)) families.push(f);
  }

  if (typeof p.minRating !== "number" || !Number.isFinite(p.minRating)) {
    return { ok: false, error: `${key}.minRating must be a number` };
  }
  // Google ratings live on a 0–5 scale, one decimal place.
  const minRating = Math.round(Math.min(Math.max(p.minRating, 0), MAX_RATING) * 10) / 10;

  if (typeof p.minReviews !== "number" || !Number.isFinite(p.minReviews)) {
    return { ok: false, error: `${key}.minReviews must be a number` };
  }
  const minReviews = Math.min(Math.max(Math.floor(p.minReviews), 0), MAX_REVIEWS);

  return { ok: true, value: { enabled: p.enabled, families, minRating, minReviews } };
}

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

  const bodyRes = await readJson<{ config?: unknown }>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const incoming = bodyRes.body.config;
  if (!incoming || typeof incoming !== "object") {
    return json({ ok: false, error: "config must be an object keyed by channel" }, 400);
  }

  // Validate every channel the caller sent before touching the row.
  const validated: Record<string, ChannelPolicy> = {};
  for (const [key, raw] of Object.entries(incoming as Record<string, unknown>)) {
    if (!CHANNELS.has(key)) {
      return json({ ok: false, error: `unknown channel "${key}"` }, 400);
    }
    const norm = normalizeChannel(key, raw);
    if (!norm.ok) return json({ ok: false, error: norm.error }, 400);
    validated[key] = norm.value;
  }
  if (Object.keys(validated).length === 0) {
    return json({ ok: false, error: "Nothing to update" }, 400);
  }

  // Merge onto the persisted config so partial saves and any future channels
  // already on the row are preserved.
  const { data: current, error: readErr } = await admin
    .from("app_settings")
    .select("sourcing_config")
    .eq("id", 1)
    .maybeSingle();
  if (readErr) {
    return json({ ok: false, error: `sourcing_config_read: ${readErr.message}` }, 500);
  }
  const base =
    current?.sourcing_config && typeof current.sourcing_config === "object"
      ? (current.sourcing_config as Record<string, unknown>)
      : {};
  const merged = { ...base, ...validated };

  const { data, error } = await admin
    .from("app_settings")
    .update({ sourcing_config: merged, updated_by: userId })
    .eq("id", 1)
    .select("sourcing_config, updated_at")
    .single();
  if (error) {
    return json({ ok: false, error: `sourcing_config_update: ${error.message}` }, 500);
  }

  return json({
    ok: true,
    config: data.sourcing_config,
    updatedAt: data.updated_at,
  });
});
