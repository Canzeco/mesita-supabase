// Supabase Edge Function — supabase-cron-run-project-creations (artificial caller / agent)
//
// The SERVICE-GATED internal create path the SQL scheduler poller invokes. It is
// the headless twin of admin-web-create-project: same ASYNC pipeline (early dedupe ->
// fetchGoogleBasics (Google identity spine, category='undefined') ->
// enricher-save-place-data (places+units, content_status='generating') ->
// triggerEnrichPlace (n8n webhook, fire-and-forget)), but gated by
// requireInternalCaller instead of getAuthedUser+requireSuperAdmin, because the
// poller is service-role with no end-user JWT and CANNOT call the JWT-gated
// natural create EFs.
//
// It also owns the queue row lifecycle: given a scheduled_id, it writes the row
// to 'done' (with the result summary) or 'failed' (with the error). The poller
// already marked the row 'running' + bumped attempts before firing this call.
//
// Like admin-web-create-project, the scheduler creates an UNOWNED listing
// (listing_type='web' is set by enricher-save-place-data); there is NO businesses
// upsert here.
//
// Contract: verify_jwt=false; requireInternalCaller gates the service-role
// bearer. Mirrors enricher-save-place-data / enricher-store-place-images.
//
// Local:  supabase functions serve supabase-cron-run-project-creations
// Deploy: supabase functions deploy supabase-cron-run-project-creations

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller, requireInternalCaller } from "../_shared/internal.ts";
import { triggerEnrichPlace } from "../_shared/n8n.ts";
import { fetchGoogleBasics } from "../_shared/atlas-google-basics.ts";

// `googlePlaceId` is the Google Place ID of the place to create (MESITA-51
// addendum 9: `placeId` is reserved for place-row UUIDs platform-wide, so
// the Google semantic moves to a distinct key on this new slug). The legacy
// `placeId` key is still accepted as a fallback for manual invocations.
type Body = { googlePlaceId?: string; placeId?: string; scheduled_id?: string };

// enricher-save-place-data response.
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
  const placeId = (bodyRes.body.googlePlaceId ?? bodyRes.body.placeId ?? "").toString().trim();
  const scheduledId = (bodyRes.body.scheduled_id ?? "").toString().trim() || null;
  if (!placeId) return json({ ok: false, error: "googlePlaceId is required" }, 400);

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
      .from("scheduled_project_creations")
      .update({
        status,
        result: fields.result ?? null,
        error: fields.error ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", scheduledId);
  };

  // ── Early dedupe (idempotency on google_place_id) ─────────────────────────
  // The input IS the place's google_place_id. Reject already-onboarded places
  // BEFORE spending any enrichment budget. enricher-save-place-data dedupes again as
  // a race guard. A duplicate is terminal 'failed' for the queue row carrying the
  // existing-place code so the operator can see why.
  const { data: existing } = await admin
    .from("projects_view")
    .select("id, slug, name, status, listing_type")
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (existing) {
    await finishRow("failed", { error: "place_already_exists", result: { existing } });
    return json(
      { ok: false, code: "place_already_exists", error: "This place is already on Mesita.", existing },
      409,
    );
  }

  // ── 1) Minimal seed — Google basics only (Default process). fetchGoogleBasics
  // builds the identity spine directly (no EF hop); category is left 'undefined'
  // for the n8n Enricher to infer at S5. NO Apify/Firecrawl/Perplexity/OpenAI
  // here — deep enrichment is async (step 3). ──
  const GOOGLE_KEY = Deno.env.get("GMP_KEY") ?? Deno.env.get("SUPA_GMP_KEY");
  if (!GOOGLE_KEY) {
    await finishRow("failed", { error: "server_misconfigured: missing GMP_KEY" });
    return json({ ok: false, error: "Server misconfigured (missing core secrets)" }, 500);
  }
  const basicsRes = await fetchGoogleBasics(placeId, GOOGLE_KEY);
  if (!basicsRes.ok) {
    await finishRow("failed", { error: `google_basics: ${basicsRes.error}` });
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
  // Enricher flips it to 'ready' via enricher-write-place-data. No businesses
  // upsert — the scheduler creates an unowned listing. ──
  const saveRes = await invokeArtificialCaller<SaveResult>(
    env,
    "supabase-cron-run-project-creations",
    "enricher-save-place-data",
    { place, content_status: "generating" },
  );
  if (!saveRes.ok) {
    await finishRow("failed", { error: `save_unit_data: ${saveRes.error}` });
    return json({ ok: false, error: saveRes.error }, saveRes.status || 502);
  }
  const saved = saveRes.data;
  const project = { id: saved.unit_id, slug: saved.slug, name: saved.name, status: saved.status };

  // ── 3) Hand deep enrichment to the n8n Enricher (async). Fire-and-forget: the
  // webhook acks immediately, the workflow runs in n8n. A trigger failure NEVER
  // fails creation — the row exists ('generating') and can be re-triggered. ──
  const trigger = await triggerEnrichPlace(saved.unit_id, placeId);

  // ── Build the create summary (same shape as admin-web-create-project; now async). ──
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
  await finishRow("done", { result: { place: project, enrichment } });

  return json({ ok: true, place: project, enrichment, caller: callerRes.callerName }, 201);
});
