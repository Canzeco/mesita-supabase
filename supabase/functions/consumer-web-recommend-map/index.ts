// Supabase Edge Function — consumer-web-recommend-map (natural caller)
//
// Consumer catalog view. Resolves the caller's profile (anonymous OK) and
// runs the catalog-ranking pipeline in-process via
// _shared/recommender-rank-map.ts. The pipeline used to live behind the
// recommender-rank-map artificial-caller EF; the HTTP hop was a synchronous
// 1:1 forward, so it was absorbed here (MESITA-54). Any future surface —
// business, admin, scheduled refresh — imports the same _shared module.
//
// Local:  supabase functions serve consumer-web-recommend-map
// Deploy: supabase functions deploy consumer-web-recommend-map

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import { adminClient, getOptionalAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { clampPositive, type ConsumerProfile } from "../_shared/recommender-pool.ts";
import { rankMapCatalog } from "../_shared/recommender-rank-map.ts";

const DEFAULT_RADIUS_KM = 25;

type Body = {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  maxCategories?: number;
  perCategory?: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Honour the bearer if present — signed-in consumers get personalisation.
  // RLS-aware reads through the user-scoped client; anonymous is fine.
  const { user, userClient } = await getOptionalAuthedUser(req, env);
  let profile: ConsumerProfile | null = null;
  if (user && userClient) {
    const { data } = await userClient
      .from("consumers")
      .select("full_name, country, birthday, sex, class_key")
      .eq("id", user.id)
      .maybeSingle();
    if (data) {
      const { class_key, ...rest } = data as Record<string, unknown>;
      profile = { ...(rest as ConsumerProfile), tier: (class_key as string) ?? "free" };
    }
  }

  const body = await readJsonOr<Body>(req, {});
  const lat = typeof body.lat === "number" && Number.isFinite(body.lat) ? body.lat : null;
  const lng = typeof body.lng === "number" && Number.isFinite(body.lng) ? body.lng : null;
  const radiusKm = clampPositive(body.radiusKm, DEFAULT_RADIUS_KM, 200);

  const admin = adminClient(env);
  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");

  const ranked = await rankMapCatalog(admin, OPENAI_KEY, "consumer-web-recommend-map", {
    lat,
    lng,
    radiusKm,
    maxCategories: Number(body.maxCategories),
    perCategory: Number(body.perCategory),
    profile,
  });
  if (!ranked.ok) {
    return json({ ok: false, error: ranked.error }, 502);
  }
  return json(ranked);
});
