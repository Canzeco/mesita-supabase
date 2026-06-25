// Supabase Edge Function — business-create-unit
//
// The LIVE business create path. The signed-in business passes a Google
// Places `placeId`; this function authenticates the business, delegates the
// Google-basics seed to atlas-seed-place (sync), then dispatches
// atlas-enrich-place (async) — no heavy work at create time. The seed inserts
// the venue row (adea_status='generating') and returns { id, slug, name,
// status }; the async enricher completes the profile and lands 'ready'. The
// Firecrawl/Perplexity/OpenAI/CSE/Instagram pipeline that create used to run
// inline is gone — atlas-enrich-place re-does every bit of it in its tiers, so
// running it here was pure duplication and made create slow.
//
// Local:  supabase functions serve business-create-unit
// Deploy: supabase functions deploy business-create-unit

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

// Supabase background-task API — keeps the worker alive past the HTTP response
// so the fire-and-forget enrichment dispatch completes. Declared for deno check.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

type EnrichBody = { placeId?: string };

// Shape atlas-seed-place returns on success. invokeArtificialCaller wraps this
// in { ok: true, data: SeedResult } — read it from seedRes.data.
type SeedResult = { id: string; slug: string; name: string; status: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Authenticate caller.
  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;
  const userEmail = authRes.user.email;

  // Parse input.
  const bodyRes = await readJson<EnrichBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  // Service-role client for the businesses ownership upsert and the
  // failed-marking write on the async enrich dispatch. atlas-seed-place owns
  // the venue insert; the caller keeps the end-user-tied writes because the
  // seed is venue-only and has no end user.
  const admin = adminClient(env);

  // ── Business ownership ───────────────────────────────────────────────
  // Upsert the signed-in business so the businesses row exists for any later
  // ownership claim. This MUST run on the caller side — atlas-seed-place is
  // venue-only and never sees the end user. Intentionally no venue_members
  // insert: the caller becomes the owner only when admin-decide-verification
  // approves their ownership claim; until then the venue is publicly listed
  // but unowned.
  const { error: businessError } = await admin
    .from("businesses")
    .upsert({ id: userId, email: userEmail }, { onConflict: "id" });
  if (businessError) {
    return json({ ok: false, error: `business_upsert: ${businessError.message}` }, 500);
  }

  // ── Delegate the Google-basics seed to atlas-seed-place (synchronous) ──
  // The seed fetches Google Places BASICS only, inserts the venue row with
  // adea_status='generating', is idempotent on google_place_id, and returns
  // { id, slug, name, status }. We await it so the business gets a created
  // venue back immediately. The seed already performs its own placeId dedupe
  // and returns 409 venue_already_exists / 422 google_spine_incomplete /
  // 502/503 google errors — we pass those through unchanged so the business
  // UI is identical to before the refactor.
  const seedRes = await invokeArtificialCaller<SeedResult>(
    env,
    "business-create-unit",
    "atlas-seed-place",
    { placeId },
  );
  if (!seedRes.ok) {
    return json({ ok: false, error: seedRes.error }, seedRes.status || 502);
  }
  const venue = seedRes.data; // { id, slug, name, status }

  // ── Phase 2a: hand the fresh venue to the profile-enricher NON-BLOCKING ──
  // Create returns immediately; the heavy Atlas pipeline runs in a background
  // task (EdgeRuntime.waitUntil) keyed on the SEEDED venue id. The caller name
  // stays 'business-create-unit' so admin-enrich attribution is unchanged.
  // atlas-enrich-place keeps adea_status 'generating' while working then lands
  // 'ready'; if the invocation errors we mark it 'failed' here (the enricher
  // does NOT write 'failed' itself). The venue surfaces to consumers (RLS gates
  // on adea_status='ready') only once enrichment completes. atlas-enrich-place
  // reads only `venue_id` and re-loads everything else from the seeded row.
  const markEnrichFailed = () =>
    admin.from("venues").update({ adea_status: "failed" }).eq("id", venue.id);
  EdgeRuntime.waitUntil(
    invokeArtificialCaller(
      env,
      "business-create-unit",
      "atlas-enrich-place",
      { venue_id: venue.id },
    )
      .then((enrichRes) => (enrichRes.ok ? undefined : markEnrichFailed()))
      .catch(() => markEnrichFailed()),
  );

  return json(
    {
      ok: true,
      venue,
      enrichment: {
        google: true,
        // Enrichment runs asynchronously now — reports the dispatch, not
        // completion. The venue lands 'ready' (discoverable) in the background;
        // adea_status starts 'generating' at seed time.
        enrichmentTriggered: true,
        enrichmentAsync: true,
        // The heavy create-time work (photo vision ranking, Firecrawl,
        // Perplexity, OpenAI synth, Instagram, channel/CSE sourcing) moved into
        // atlas-seed-place (basics) + atlas-enrich-place (the rest). These
        // fields are kept for response-contract compatibility with existing
        // business-web clients reading enrichment.* — they no longer report
        // create-time work and so are neutralised. atlas-seed-place does not
        // echo per-seed counts in its response today, so seed-derived values
        // stay 0/null here.
        photoCount: 0,
        photoCandidates: 0,
        photoRanked: false,
        firecrawl: false,
        perplexity: false,
        openai: false,
        openaiError: null,
        channelCount: 0,
        googleRating: null,
        googleReviewCount: null,
        instagramFollowers: null,
      },
    },
    201,
  );
});
