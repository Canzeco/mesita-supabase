// Supabase Edge Function — consumer-web-recommend-swipe (natural caller)
//
// Consumer swipe view. Resolves the caller's profile (anonymous OK — the
// discover surface is public until sign-up) and runs the deck-ranking
// pipeline in-process via _shared/recommender-rank-swipe.ts. The pipeline
// used to live behind the recommender-rank-swipe artificial-caller EF; the
// HTTP hop was a synchronous 1:1 forward, so it was absorbed here
// (MESITA-54). Any future surface imports the same _shared module.
//
// Local:  supabase functions serve consumer-web-recommend-swipe
// Deploy: supabase functions deploy consumer-web-recommend-swipe

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import { adminClient, getOptionalAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { clampPositive, type ConsumerProfile } from "../_shared/recommender-pool.ts";
import { rankSwipeDeck } from "../_shared/recommender-rank-swipe.ts";

const DEFAULT_RADIUS_KM = 25;
const DEFAULT_LIMIT = 50;

type Body = {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  limit?: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Honour the bearer if present so we can read the signed-in consumer's
  // profile for personalisation, but anonymous is the common path. RLS-aware
  // reads through the user-scoped client.
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
  const limit = clampPositive(body.limit, DEFAULT_LIMIT, 50);

  const admin = adminClient(env);
  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");

  const ranked = await rankSwipeDeck(admin, OPENAI_KEY, "consumer-web-recommend-swipe", {
    lat,
    lng,
    radiusKm,
    limit,
    profile,
  });
  if (!ranked.ok) {
    return json({ ok: false, error: ranked.error }, 502);
  }
  return json(ranked);
});
