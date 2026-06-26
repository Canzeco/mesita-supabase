// Supabase Edge Function — admin-create-unit (admin caller / LIVE admin create path)
//
// The admin-app equivalent of business-create-unit: an admin operator passes a
// Google Places `placeId` and gets a fully-enriched, 'ready' unit back. Same
// SYNCHRONOUS pipeline — early dedupe → atlas-get-enriched-place (read-only) →
// atlas-save-unit-data (places+units) → atlas-save-place-media (best-effort).
//
// Roles are simple now: admins create from the admin app via THIS function;
// businesses create from the business app via business-create-unit. (There is
// no "super-admin operates the business app" path anymore.)
//
// Gating: operator JWT → the admin allowlist (requireSuperAdmin checks the
// public.super_admins table — that table IS the admin allowlist; this is the
// same gate every other admin-* EF uses).
//
// Difference vs business-create-unit: NO businesses upsert — an admin creates an
// UNOWNED listing (listing_type='web'); ownership only ever lands when a business
// claims it and admin-decide-verification approves.
//
// Local:  supabase functions serve admin-create-unit
// Deploy: supabase functions deploy admin-create-unit

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv, requireSuperAdmin } from "../_shared/auth.ts";
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

  // Authenticate the admin operator against the admin allowlist.
  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;
  const admin = adminClient(env);
  const guard = await requireSuperAdmin(admin, authRes.user, "Only admins can create units.");
  if (!guard.ok) return guard.response;

  // Parse input.
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  // ── Early dedupe (idempotency on google_place_id) ─────────────────────────
  // placeId IS the venue's google_place_id. Reject already-onboarded venues
  // BEFORE spending any enrichment budget. atlas-save-unit-data dedupes again as
  // a race guard, but gating here keeps a duplicate request cheap.
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
        error: "This venue is already on Mesita.",
        existing,
      },
      409,
    );
  }

  // ── 1) Enrich — read-only, synchronous. Builds the full places-shaped profile. ──
  const enrichedRes = await invokeArtificialCaller<EnrichedResult>(
    env,
    "admin-create-unit",
    "atlas-get-enriched-place",
    { placeId },
  );
  if (!enrichedRes.ok) {
    return json({ ok: false, error: enrichedRes.error }, enrichedRes.status || 502);
  }
  const enriched = enrichedRes.data;

  // ── 2) Persist places + units (idempotent; lands status='active'/adea 'ready') ──
  // No businesses upsert — admin creates an unowned listing.
  const saveRes = await invokeArtificialCaller<SaveResult>(
    env,
    "admin-create-unit",
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
      "admin-create-unit",
      "atlas-save-place-media",
      { venue_id: saved.unit_id, assets, preferred_photo_urls: enriched.preferred_photo_urls ?? [] },
    );
    mediaSaved = mediaRes.ok;
  }

  // ── Respond — fully enriched + 'ready'; same shape as business-create-unit. ──
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
