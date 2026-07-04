// Supabase Edge Function — admin-web-create-project (admin caller / LIVE admin create path)
//
// The admin-app equivalent of business-web-create-project: an admin operator passes a
// Google Places `placeId` and gets back a MINIMAL 'generating' unit; deep
// enrichment then runs ASYNC in the n8n Enricher. Pipeline: early dedupe →
// fetchGoogleBasics (Google identity spine, category='undefined') →
// enricher-save-place-data (places+units, content_status='generating') →
// triggerEnrichPlace (n8n webhook, fire-and-forget).
//
// Roles are simple now: admins create from the admin app via THIS function;
// businesses create from the business app via business-web-create-project. (There is
// no "super-admin operates the business app" path anymore.)
//
// Gating: operator JWT → the admin allowlist (requireSuperAdmin checks the
// public.super_admins table — that table IS the admin allowlist; this is the
// same gate every other admin-* EF uses).
//
// Difference vs business-web-create-project: NO businesses upsert — an admin creates an
// UNOWNED listing (listing_type='web'); ownership only ever lands when a business
// claims it and admin-web-decide-verification approves.
//
// Local:  supabase functions serve admin-web-create-project
// Deploy: supabase functions deploy admin-web-create-project

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv, requireSuperAdmin } from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";
import { triggerEnrichPlace } from "../_shared/n8n.ts";
import { fetchGoogleBasics } from "../_shared/atlas-google-basics.ts";

type Body = { placeId?: string };

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
  // placeId IS the place's google_place_id. Reject already-onboarded places
  // BEFORE spending any enrichment budget. enricher-save-place-data dedupes again as
  // a race guard, but gating here keeps a duplicate request cheap.
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
        error: "This place is already on Mesita.",
        existing,
      },
      409,
    );
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
  // Enricher flips it to 'ready' via enricher-write-place-data. No businesses
  // upsert — admin creates an unowned listing. ──
  const saveRes = await invokeArtificialCaller<SaveResult>(
    env,
    "admin-web-create-project",
    "enricher-save-place-data",
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
  // for admin-web response-contract compatibility (now async). ──
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
