// Supabase Edge Function — business-create-unit (LIVE business create path)
//
// The signed-in business passes a Google Places `placeId`. SYNCHRONOUS create —
// the venue is fully enriched and 'ready' by the time this returns:
//   1. authenticate the business + EARLY-dedupe on google_place_id (a cheap 409
//      BEFORE any enrichment spend — the old seed gated cheaply, the new
//      read-only pipeline is expensive so the caller must gate first),
//   2. upsert the businesses row (ownership scaffolding),
//   3. await atlas-get-enriched-place — read-only, builds the full profile JSON,
//   4. await atlas-save-unit-data — writes the places + units rows,
//   5. await atlas-save-place-media — mirrors photos (best-effort; a media
//      failure never fails a created venue).
//
// The old seed → async-enrich (EdgeRuntime.waitUntil) flow is gone: there is no
// 'generating' window anymore, enrichment completes inline.
//
// Intentionally NO venue_members insert — the caller becomes owner only when
// admin-decide-verification approves the ownership claim; until then the venue
// is publicly listed but unowned.
//
// Local:  supabase functions serve business-create-unit
// Deploy: supabase functions deploy business-create-unit

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

type Body = { placeId?: string };

// atlas-get-enriched-place response — the read-only profile compute.
type EnrichedResult = {
  place: Record<string, unknown> & {
    name?: string;
    photos?: unknown;
    google_stars_overall?: number | null;
    google_review_count?: number | null;
    instagram_followers_count?: number | null;
  };
  media_assets?: unknown[];
  preferred_photo_urls?: string[];
  sources?: Record<string, unknown>;
};

// atlas-save-unit-data response.
type SaveResult = { unit_id: string; place_id: string; slug: string; name: string; status: string };

const CHANNEL_KEYS = [
  "website_url", "instagram_url", "facebook_url", "tiktok_url", "x_url", "threads_url",
  "reddit_url", "whatsapp_url", "opentable_url", "resy_url", "uber_eats_url",
  "didi_food_url", "tripadvisor_url", "yelp_url", "google_maps_url",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Authenticate the business.
  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;
  const userEmail = authRes.user.email;

  // Parse input.
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  const admin = adminClient(env);

  // ── Early dedupe (idempotency on google_place_id) ─────────────────────────
  // placeId IS the venue's google_place_id. Reject already-onboarded venues
  // BEFORE spending any enrichment budget. atlas-save-unit-data dedupes again as
  // a race guard, but gating here is what keeps a duplicate click cheap.
  const { data: existing } = await admin
    .from("venues")
    .select("id, slug, name, status, listing_type")
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (existing) {
    return json(
      {
        ok: false,
        code: "venue_already_exists",
        error: "This venue is already on Mesita. If you manage it, contact support to claim ownership.",
        existing,
      },
      409,
    );
  }

  // ── Ownership scaffolding ─────────────────────────────────────────────────
  // Upsert the signed-in business so its row exists for any later ownership
  // claim. NO venue_members insert — ownership lands at admin-decide-verification.
  const { error: businessError } = await admin
    .from("businesses")
    .upsert({ id: userId, email: userEmail }, { onConflict: "id" });
  if (businessError) {
    return json({ ok: false, error: `business_upsert: ${businessError.message}` }, 500);
  }

  // ── 1) Enrich — read-only, synchronous. Builds the full places-shaped profile. ──
  const enrichedRes = await invokeArtificialCaller<EnrichedResult>(
    env,
    "business-create-unit",
    "atlas-get-enriched-place",
    { placeId },
  );
  if (!enrichedRes.ok) {
    return json({ ok: false, error: enrichedRes.error }, enrichedRes.status || 502);
  }
  const enriched = enrichedRes.data;

  // ── 2) Persist places + units (idempotent; lands status='active'/adea 'ready') ──
  const saveRes = await invokeArtificialCaller<SaveResult>(
    env,
    "business-create-unit",
    "atlas-save-unit-data",
    { place: enriched.place },
  );
  if (!saveRes.ok) {
    return json({ ok: false, error: saveRes.error }, saveRes.status || 502);
  }
  const saved = saveRes.data;
  const venue = { id: saved.unit_id, slug: saved.slug, name: saved.name, status: saved.status };

  // ── 3) Persist media — best-effort. A media failure NEVER fails the venue. ──
  const assets = Array.isArray(enriched.media_assets) ? enriched.media_assets : [];
  let mediaSaved = false;
  if (assets.length > 0) {
    const mediaRes = await invokeArtificialCaller(
      env,
      "business-create-unit",
      "atlas-save-place-media",
      { venue_id: saved.unit_id, assets, preferred_photo_urls: enriched.preferred_photo_urls ?? [] },
    );
    mediaSaved = mediaRes.ok;
  }

  // ── Respond — fully enriched + 'ready'. enrichment.* kept for business-web
  // response-contract compatibility, now reporting real synchronous values. ──
  const place = enriched.place ?? {};
  const sources = enriched.sources ?? {};
  const channelCount = CHANNEL_KEYS.filter((k) => !!place[k]).length;

  return json(
    {
      ok: true,
      venue,
      enrichment: {
        google: true,
        enrichmentTriggered: true,
        enrichmentAsync: false,
        photoCount: Array.isArray(place.photos) ? place.photos.length : 0,
        photoCandidates: assets.length,
        photoRanked: mediaSaved,
        firecrawl: !!sources.firecrawl,
        perplexity: !!(sources.serp || sources.discovery),
        openai: !!sources.synthesis,
        openaiError: null,
        channelCount,
        googleRating: (place.google_stars_overall as number | null) ?? null,
        googleReviewCount: (place.google_review_count as number | null) ?? null,
        instagramFollowers: (place.instagram_followers_count as number | null) ?? null,
      },
    },
    201,
  );
});
