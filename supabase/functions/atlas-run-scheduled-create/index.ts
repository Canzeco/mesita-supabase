// Supabase Edge Function — atlas-run-scheduled-create (artificial caller / agent)
//
// The SERVICE-GATED internal create path the SQL scheduler poller invokes. It is
// the headless twin of admin-create-unit: same pipeline (early dedupe ->
// atlas-get-enriched-place (read-only) -> atlas-save-unit-data (places+units) ->
// atlas-save-place-media (best-effort)), but gated by requireInternalCaller
// instead of getAuthedUser+requireSuperAdmin, because the poller is service-role
// with no end-user JWT and CANNOT call the JWT-gated natural create EFs.
//
// It also owns the queue row lifecycle: given a scheduled_id, it writes the row
// to 'done' (with the result summary) or 'failed' (with the error). The poller
// already marked the row 'running' + bumped attempts before firing this call.
//
// Like admin-create-unit, the scheduler creates an UNOWNED listing
// (listing_type='web' is set by atlas-save-unit-data); there is NO businesses
// upsert here.
//
// Contract: verify_jwt=false; requireInternalCaller gates the service-role
// bearer. Mirrors atlas-get-enriched-place / atlas-save-unit-data / atlas-save-place-media.
//
// Local:  supabase functions serve atlas-run-scheduled-create
// Deploy: supabase functions deploy atlas-run-scheduled-create

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller, requireInternalCaller } from "../_shared/internal.ts";
import { triggerEnrichPlace } from "../_shared/n8n.ts";

type Body = { placeId?: string; scheduled_id?: string };

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

  // Service-role gate — the poller (and only the poller) reaches this EF.
  const callerRes = requireInternalCaller(req, env);
  if (!callerRes.ok) return callerRes.response;

  // Parse input.
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  const scheduledId = (bodyRes.body.scheduled_id ?? "").toString().trim() || null;
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  const admin = adminClient(env);

  // Writes the queue row's terminal state. Best-effort — a row-update failure
  // never masks the real pipeline result we return to the caller. Touching
  // updated_at lets the reaper distinguish a row that's actively progressing
  // from a genuinely stuck one.
  const finishRow = async (
    status: "done" | "failed",
    fields: { result?: unknown; error?: string | null },
  ) => {
    if (!scheduledId) return;
    await admin
      .from("scheduled_unit_creations")
      .update({
        status,
        result: fields.result ?? null,
        error: fields.error ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", scheduledId);
  };

  // ── Early dedupe (idempotency on google_place_id) ─────────────────────────
  // placeId IS the venue's google_place_id. Reject already-onboarded venues
  // BEFORE spending any enrichment budget. atlas-save-unit-data dedupes again as
  // a race guard. A duplicate is terminal 'failed' for the queue row carrying the
  // existing-venue code so the operator can see why.
  const { data: existing } = await admin
    .from("venues")
    .select("id, slug, name, status, listing_type")
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (existing) {
    await finishRow("failed", { error: "venue_already_exists", result: { existing } });
    return json(
      { ok: false, code: "venue_already_exists", error: "This venue is already on Mesita.", existing },
      409,
    );
  }

  // ── 1) Minimal enrich — Google basics + category only (Default process). Deep
  // enrichment is handed to the n8n Enricher in step 3 (async). ──
  const enrichedRes = await invokeArtificialCaller<EnrichedResult>(
    env,
    "atlas-run-scheduled-create",
    "atlas-get-enriched-place",
    { placeId, minimal: true },
  );
  if (!enrichedRes.ok) {
    await finishRow("failed", { error: `get_enriched: ${enrichedRes.error}` });
    return json({ ok: false, error: enrichedRes.error }, enrichedRes.status || 502);
  }
  const enriched = enrichedRes.data;

  // ── 2) Persist the minimal row — lands adea_status='generating' until the
  // Enricher flips it to 'ready' via atlas-update-unit-data. No businesses
  // upsert — the scheduler creates an unowned listing. ──
  const saveRes = await invokeArtificialCaller<SaveResult>(
    env,
    "atlas-run-scheduled-create",
    "atlas-save-unit-data",
    { place: enriched.place, adea_status: "generating" },
  );
  if (!saveRes.ok) {
    await finishRow("failed", { error: `save_unit_data: ${saveRes.error}` });
    return json({ ok: false, error: saveRes.error }, saveRes.status || 502);
  }
  const saved = saveRes.data;
  const venue = { id: saved.unit_id, slug: saved.slug, name: saved.name, status: saved.status };

  // ── 3) Hand deep enrichment to the n8n Enricher (async). Fire-and-forget: the
  // webhook acks immediately, the workflow runs in n8n. A trigger failure NEVER
  // fails creation — the row exists ('generating') and can be re-triggered. ──
  const trigger = await triggerEnrichPlace(saved.unit_id, placeId);

  // ── Build the create summary (same shape as admin-create-unit; now async). ──
  const place = enriched.place ?? {};
  const channelCount = CHANNEL_KEYS.filter((k) => !!place[k]).length;
  const enrichment = {
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
  };

  // ── Mark the queue row done — the unit was created and enrichment dispatched. ──
  await finishRow("done", { result: { venue, enrichment } });

  return json({ ok: true, venue, enrichment, caller: callerRes.callerName }, 201);
});
