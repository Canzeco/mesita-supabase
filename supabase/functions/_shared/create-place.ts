// Shared create-place core — the pipeline every create path runs after its
// caller-specific auth:
//
//   early dedupe (google_place_id) → fetchGoogleBasics (identity spine,
//   category='undefined') → savePlaceData (minimal 'generating' rows,
//   in-process) → seedPlaceResearch (queue the Enricher pipeline).
//
// Callers: admin-web-create-unit, business-web-create-project,
// consumer-web-create-place (+ its consumer-web-schedule-project-creation
// compat alias). All create IMMEDIATELY (MESITA-127/128 dropped the staggered
// queue); only auth, dedupe copy, and response shaping differ per EF.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { seedPlaceResearch } from "./enrich-pipeline.ts";
import { fetchGoogleBasics } from "./enrich-google-basics.ts";
import { savePlaceData } from "./save-place.ts";

const CHANNEL_KEYS = [
  "website_url", "instagram_url", "facebook_url", "tiktok_url", "x_url", "threads_url",
  "reddit_url", "whatsapp_url", "opentable_url", "resy_url", "uber_eats_url",
  "didi_food_url", "tripadvisor_url", "yelp_url", "google_maps_url",
];

export type CreatedPlace = { id: string; slug: string; name: string; status: string };

// The `enrichment` block every create response carries (response-contract
// compatibility from the days enrichment was synchronous — now always async).
export type EnrichmentSummary = {
  google: boolean;
  enrichmentTriggered: boolean;
  enrichmentAsync: true;
  enrichmentError: string | null;
  photoCount: number;
  photoCandidates: 0;
  photoRanked: false;
  firecrawl: false;
  perplexity: false;
  openai: false;
  openaiError: null;
  channelCount: number;
  googleRating: number | null;
  googleReviewCount: number | null;
  instagramFollowers: number | null;
};

export type CreatePlaceOutcome =
  | { ok: true; place: CreatedPlace; enrichment: EnrichmentSummary }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function createMinimalPlace(opts: {
  admin: SupabaseClient;
  // The natural caller's EF name — recorded as place_research.created_by.
  callerName: string;
  googlePlaceId: string;
  // Caller-specific copy for the 409 (e.g. the business app adds claim advice).
  dedupeError?: string;
}): Promise<CreatePlaceOutcome> {
  const { admin, callerName, googlePlaceId } = opts;

  // ── Early dedupe (idempotency on google_place_id): reject already-onboarded
  // places BEFORE spending any budget. savePlaceData dedupes again as a race
  // guard; gating here keeps a duplicate click cheap. ──
  const { data: existing } = await admin
    .from("projects_view")
    .select("id, slug, name, status, listing_type")
    .eq("google_place_id", googlePlaceId)
    .maybeSingle();
  if (existing) {
    return {
      ok: false,
      status: 409,
      body: {
        ok: false,
        code: "place_already_exists",
        error: opts.dedupeError ?? "This place is already on Mesita.",
        existing,
      },
    };
  }

  // ── 1) Minimal seed — Google basics only. fetchGoogleBasics builds the
  // identity spine directly (no EF hop); category stays 'undefined' until the
  // Enricher pipeline's contents stage infers the real one. No
  // Apify/Firecrawl/Perplexity/OpenAI here — deep enrichment is async. ──
  const GOOGLE_KEY = Deno.env.get("GMP_KEY") ?? Deno.env.get("SUPA_GMP_KEY");
  if (!GOOGLE_KEY) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: "Server misconfigured (missing core secrets)" },
    };
  }
  const basicsRes = await fetchGoogleBasics(googlePlaceId, GOOGLE_KEY);
  if (!basicsRes.ok) {
    return {
      ok: false,
      status: basicsRes.status || 502,
      body: { ok: false, code: basicsRes.code, error: basicsRes.error },
    };
  }
  // category 'undefined' until the Enricher resolves it; the category-label
  // trigger fills category_label from the 'undefined' catalog row.
  const place: Record<string, unknown> = {
    ...basicsRes.basics,
    category: "undefined",
    category_label: null,
  };

  // ── 2) Persist the minimal rows (in-process) — lands
  // content_status='generating' until the Enricher pipeline's contents stage
  // flips it to 'ready'. ──
  const saveRes = await savePlaceData(admin, place, "generating");
  if (!saveRes.ok) {
    return { ok: false, status: saveRes.status, body: saveRes.body };
  }
  const saved = saveRes.saved;

  // ── 3) Queue deep enrichment (async): seed the place_research row at
  // stage='research'; the pg_cron poller picks it up
  // (supabase-cron-enrich-place-*). A seed failure NEVER fails the create —
  // the row exists ('generating') and can be re-seeded. ──
  const trigger = await seedPlaceResearch(admin, saved.unit_id, googlePlaceId, callerName);

  const channelCount = CHANNEL_KEYS.filter((k) => !!place[k]).length;
  return {
    ok: true,
    place: { id: saved.unit_id, slug: saved.slug, name: saved.name, status: saved.status },
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
  };
}
