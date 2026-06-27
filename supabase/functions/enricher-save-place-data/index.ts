// Supabase Edge Function — enricher-save-place-data (artificial caller / agent)
//
// The PERSIST half of the create pipeline. Takes the `place` JSON produced by
// atlas-get-enriched-place (read-only) and writes it as the real rows:
//   • places — the full Atlas profile (Google identity, geo, channels, signals,
//     synthesis, photos)
//   • units  — the owned Mesita entity (shared PK with the place), landing
//     status='active', listing_type='web', and a caller-supplied content_status
//     (the async create path passes 'generating'; defaults to 'ready').
//
// Idempotent on google_place_id (409 place_already_exists). Slug is made unique
// against the live catalog. Inserts are sequenced places→units (shared id); a
// units failure compensates by deleting the just-written place so we never
// leave an orphan profile. Media is NOT handled here — the caller invokes
// enricher-save-place-media next with the media_assets get-enriched returned.
//
// Ownership (project_members) is intentionally NOT created here — the caller
// (business-create-project) owns the businesses upsert; ownership only lands when
// admin-decide-verification approves a claim. This agent is place-only.
//
// Contract: verify_jwt=false; requireInternalCaller gates the service-role
// bearer. Mirrors how atlas-get-enriched-place / enricher-save-place-media are gated.
//
// Local:  supabase functions serve enricher-save-place-data
// Deploy: supabase functions deploy enricher-save-place-data

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import { ensureUniqueSlug, slugify } from "../_shared/place-slug.ts";

// The places-shaped profile from atlas-get-enriched-place. Required spine:
// google_place_id + name (the same fields fetchGoogleBasics guarantees).
type PlacePayload = Record<string, unknown> & {
  google_place_id?: string;
  name?: string;
};
type Body = { place?: PlacePayload; content_status?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const place = bodyRes.body.place;
  if (!place || typeof place !== "object") {
    return json({ ok: false, error: "place is required" }, 400);
  }
  const googlePlaceId = (place.google_place_id ?? "").toString().trim();
  const name = (place.name ?? "").toString().trim();
  if (!googlePlaceId) return json({ ok: false, error: "place.google_place_id is required" }, 400);
  if (!name) return json({ ok: false, error: "place.name is required" }, 400);

  // content_status is caller-controlled: the synchronous create lands 'ready'; the
  // async create path lands 'generating' (the n8n Enricher flips it to 'ready'
  // later via enricher-update-place-data). Defaults to 'ready' for back-compat.
  const ADEA_STATUSES = new Set(["queued", "generating", "ready", "failed"]);
  const adeaRaw = (bodyRes.body.content_status ?? "ready").toString().trim();
  const adeaStatus = ADEA_STATUSES.has(adeaRaw) ? adeaRaw : "ready";

  const admin = adminClient(envRes.env);

  // ── Idempotency: already onboarded? (read the joined view) ──
  const { data: existing } = await admin
    .from("projects_view")
    .select("id, slug, name, status, listing_type")
    .eq("google_place_id", googlePlaceId)
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

  // ── Unique slug against the live catalog (places view exposes units.slug) ──
  const slug = await ensureUniqueSlug(admin, slugify(name));

  // ── 1) places (profile). Strip caller-supplied id/timestamps so the DB owns
  // them; the category-label trigger fills category_label from category. ──
  const { id: _dropId, created_at: _dropCreated, updated_at: _dropUpdated, ...placeInsert } = place;
  const { data: placeRow, error: placeErr } = await admin
    .from("places")
    .insert(placeInsert)
    .select("id")
    .single();
  if (placeErr || !placeRow) {
    if (placeErr?.code === "23505" && /google_place_id/.test(placeErr.message)) {
      const after = await admin
        .from("projects_view")
        .select("id, slug, name, status, listing_type")
        .eq("google_place_id", googlePlaceId)
        .maybeSingle();
      return json(
        {
          ok: false,
          code: "place_already_exists",
          error: "This place is already on Mesita. If you manage it, contact support to claim ownership.",
          existing: after.data ?? null,
        },
        409,
      );
    }
    return json({ ok: false, error: `place_insert: ${placeErr?.message ?? "no row"}`, code: placeErr?.code ?? null }, 400);
  }

  // ── 2) units (entity, shared PK). content_status is caller-supplied (async create
  // → 'generating'; default 'ready'). ──
  const { data: unitRow, error: unitErr } = await admin
    .from("projects")
    .insert({
      id: placeRow.id,
      slug,
      status: "active",
      listing_type: "web",
      content_status: adeaStatus,
    })
    .select("id, slug, status")
    .single();
  if (unitErr || !unitRow) {
    // Compensate: drop the orphan place so a failed create leaves nothing.
    await admin.from("places").delete().eq("id", placeRow.id);
    if (unitErr?.code === "23505" && /\bslug\b/.test(unitErr.message)) {
      return json(
        { ok: false, code: "slug_already_taken", error: "A place with this URL slug already exists. Try again." },
        409,
      );
    }
    return json({ ok: false, error: `unit_insert: ${unitErr?.message ?? "no row"}`, code: unitErr?.code ?? null }, 400);
  }

  return json(
    {
      ok: true,
      unit_id: unitRow.id,
      place_id: placeRow.id,
      slug: unitRow.slug,
      name,
      status: unitRow.status,
      caller: callerRes.callerName,
    },
    201,
  );
});
