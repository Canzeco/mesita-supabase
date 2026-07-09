// Shared create-place core — the pipeline every create path runs after its
// caller-specific auth:
//
//   early dedupe (google_place_id) → per-user quota (consumer paths) →
//   fetchGoogleBasics (identity spine,
//   category='undefined') → savePlaceData (minimal 'generating' rows,
//   in-process) → seedPlaceResearch (queue the Enricher pipeline).
//
// Callers: admin-web-create-project, business-web-create-project,
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

// Rolling-window creation quota for the CONSUMER add paths (the live EF and
// its schedule-project-creation compat alias import this same constant so the
// bound stays in lockstep). Admin/business creates pass no quota. 10/24h caps
// a scripted consumer's worst-case spend (a Google Basics call per attempt +
// ~$0.35+/place Enricher run) while staying far above honest Add usage.
export const CONSUMER_PLACE_CREATE_QUOTA = { limit: 10, windowHours: 24 };

export type CreateQuota = {
  // auth.users id of the caller — the ledger key.
  userId: string;
  limit: number;
  windowHours: number;
};

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
  // Rolling-window per-user creation quota (consumer paths). Enforced after
  // the dedupe (a duplicate click never burns quota) and BEFORE
  // fetchGoogleBasics (an over-quota call spends nothing).
  quota?: CreateQuota;
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

  // ── Per-user creation quota (public.place_creation_attempts ledger).
  // Attempt row FIRST, then count the window: under parallel scripted
  // requests every racer sees its own row, so at most `limit` creates can
  // proceed regardless of concurrency. Attempts (not successes) count — a
  // failed Google lookup still billed a Basics call. Ledger errors fail
  // CLOSED: unbounded paid-API spend is worse than a blocked create. ──
  if (opts.quota) {
    const { userId, limit, windowHours } = opts.quota;
    const { error: ledgerError } = await admin
      .from("place_creation_attempts")
      .insert({ user_id: userId, google_place_id: googlePlaceId, caller: callerName });
    if (ledgerError) {
      return {
        ok: false,
        status: 500,
        body: { ok: false, error: "Could not record the creation attempt. Try again." },
      };
    }
    const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    const { count, error: countError } = await admin
      .from("place_creation_attempts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", since);
    if (countError || count == null) {
      return {
        ok: false,
        status: 500,
        body: { ok: false, error: "Could not check your creation quota. Try again." },
      };
    }
    if (count > limit) {
      return {
        ok: false,
        status: 429,
        body: {
          ok: false,
          code: "creation_quota_exceeded",
          error:
            `You've added the maximum of ${limit} new places in the last ${windowHours} hours. Try again later.`,
        },
      };
    }
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
