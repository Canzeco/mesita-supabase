// Supabase Edge Function — business-web-create-project (LIVE business create path)
//
// The signed-in business passes a Google Places `googlePlaceId`. ASYNC create — a
// MINIMAL 'generating' place is returned immediately and deep enrichment runs in
// the n8n Enricher:
//   1. authenticate the business + EARLY-dedupe on google_place_id (a cheap 409
//      BEFORE any enrichment spend),
//   2. upsert the businesses row (ownership scaffolding),
//   3. fetchGoogleBasics — the Google identity spine (category='undefined'),
//   4. enricher-agent-save-place-data — writes places + units (content_status='generating'),
//   5. triggerEnrichPlace — hands deep enrichment to the n8n Enricher
//      (fire-and-forget; the Enricher flips content_status→'ready' when done).
//
// Intentionally NO project_members insert — the caller becomes owner only when
// admin-web-decide-verification approves the ownership claim; until then the place
// is publicly listed but unowned.
//
// Local:  supabase functions serve business-web-create-project
// Deploy: supabase functions deploy business-web-create-project

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";
import { triggerEnrichPlace } from "../_shared/n8n.ts";
import { fetchGoogleBasics } from "../_shared/atlas-google-basics.ts";

// `googlePlaceId` is the canonical key (Google Place ID). Legacy `placeId`
// is accepted as a fallback until every client sends the new key — it was
// semantically overloaded (Google ID here, place-row UUID on the
// readPlaceIdAlias endpoints), so the new slug disambiguates.
type Body = { googlePlaceId?: string; placeId?: string };

// enricher-agent-save-place-data response.
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
  const placeId = (bodyRes.body.googlePlaceId ?? bodyRes.body.placeId ?? "")
    .toString()
    .trim();
  if (!placeId) {
    return json({ ok: false, error: "googlePlaceId is required" }, 400);
  }

  const admin = adminClient(env);

  // ── Early dedupe (idempotency on google_place_id) ─────────────────────────
  // placeId IS the place's google_place_id. Reject already-onboarded places
  // BEFORE spending any enrichment budget. enricher-agent-save-place-data dedupes again as
  // a race guard, but gating here is what keeps a duplicate click cheap.
  const { data: existing } = await admin
    .from("projects_view")
    .select("id, slug, name, status, listing_type")
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (existing) {
    return json(
      {
        ok: false,
        code: "place_already_exists",
        error: "This place is already on Mesita. If you manage it, contact support to claim ownership.",
        existing,
      },
      409,
    );
  }

  // ── Ownership scaffolding ─────────────────────────────────────────────────
  // Upsert the signed-in business so its row exists for any later ownership
  // claim. NO project_members insert — ownership lands at admin-web-decide-verification.
  const { error: businessError } = await admin
    .from("accounts")
    .upsert({ id: userId, email: userEmail }, { onConflict: "id" });
  if (businessError) {
    return json({ ok: false, error: `business_upsert: ${businessError.message}` }, 500);
  }

  // ── 1) Minimal seed — Google basics only (Default process). fetchGoogleBasics
  // builds the identity spine directly (no EF hop); category is left 'undefined'
  // for the n8n Enricher to infer at S5. NO Apify/Firecrawl/Perplexity/OpenAI
  // here — deep enrichment is async (step 3). ──
  const GOOGLE_KEY = Deno.env.get("GMP_KEY") ?? Deno.env.get("SUPA_GMP_KEY");
  if (!GOOGLE_KEY) {
    return json({ ok: false, error: "Server misconfigured (missing core secrets)" }, 500);
  }
  const basicsRes = await fetchGoogleBasics(placeId, GOOGLE_KEY);
  if (!basicsRes.ok) {
    return json({ ok: false, code: basicsRes.code, error: basicsRes.error }, basicsRes.status || 502);
  }
  // category 'undefined' until the Enricher resolves it; the category-label
  // trigger fills category_label from the 'undefined' catalog row.
  const place: Record<string, unknown> = {
    ...basicsRes.basics,
    category: "undefined",
    category_label: null,
  };

  // ── 2) Persist the minimal row — lands content_status='generating' until the
  // Enricher flips it to 'ready' via enricher-agent-write-place-data. ──
  const saveRes = await invokeArtificialCaller<SaveResult>(
    env,
    "business-web-create-project",
    "enricher-agent-save-place-data",
    { place, content_status: "generating" },
  );
  if (!saveRes.ok) {
    return json({ ok: false, error: saveRes.error }, saveRes.status || 502);
  }
  const saved = saveRes.data;
  const project = { id: saved.unit_id, slug: saved.slug, name: saved.name, status: saved.status };

  // ── 3) Hand deep enrichment to the n8n Enricher (async). Fire-and-forget: the
  // webhook acks immediately, the workflow runs in n8n. A trigger failure NEVER
  // fails the create — the row exists ('generating') and can be re-triggered. ──
  const trigger = await triggerEnrichPlace(saved.unit_id, placeId);

  // ── Respond — minimal row created; deep enrichment in flight. enrichment.* kept
  // for business-web response-contract compatibility (now async). ──
  const channelCount = CHANNEL_KEYS.filter((k) => !!place[k]).length;

  return json(
    {
      ok: true,
      place: project,
      enrichment: {
        google: true,
        enrichmentTriggered: trigger.ok,
        enrichmentAsync: true,
        enrichmentError: trigger.ok ? null : trigger.error ?? null,
        photoCount: Array.isArray(place.photos) ? place.photos.length : 0,
        photoCandidates: 0,
        photoRanked: false,
        firecrawl: false,
        perplexity: false,
        openai: false,
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
