// Shared persist half of the create pipeline (formerly the
// enricher-agent-save-place-data EF — folded in-process per the caller
// doctrine: artificial callers survive only as shared code; the HTTP hop no
// longer earned its cost once create-place.ts became the single call site).
//
// Takes the `place` JSON produced by fetchGoogleBasics and writes it as the
// real rows:
//   • places   — the profile (Google identity, geo, channels, signals, photos)
//   • projects — the owned Mesita entity (shared PK with the place), landing
//     status='active', listing_type='web', and a caller-supplied
//     content_status (the async create path passes 'generating').
//
// Idempotent on google_place_id (place_already_exists). Slug is made unique
// against the live catalog. Inserts are sequenced places→projects (shared id);
// a projects failure compensates by deleting the just-written place so we
// never leave an orphan profile. Media is NOT handled here.
//
// Ownership (project_members) is intentionally NOT created here — ownership
// only lands when admin-web-decide-verification approves a claim.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ensureUniqueSlug, slugify } from "./place-slug.ts";

// The places-shaped profile from fetchGoogleBasics. Required spine:
// google_place_id + name (the same fields fetchGoogleBasics guarantees).
export type PlacePayload = Record<string, unknown> & {
  google_place_id?: string;
  name?: string;
};

export type SavedPlace = {
  unit_id: string;
  place_id: string;
  slug: string;
  name: string;
  status: string;
};

export type SavePlaceOutcome =
  | { ok: true; saved: SavedPlace }
  | { ok: false; status: number; body: Record<string, unknown> };

const CONTENT_STATUSES = new Set(["queued", "generating", "ready", "failed"]);

export async function savePlaceData(
  admin: SupabaseClient,
  place: PlacePayload,
  contentStatus = "ready",
): Promise<SavePlaceOutcome> {
  const fail = (status: number, body: Record<string, unknown>): SavePlaceOutcome => ({
    ok: false,
    status,
    body: { ok: false, ...body },
  });

  const googlePlaceId = (place.google_place_id ?? "").toString().trim();
  const name = (place.name ?? "").toString().trim();
  if (!googlePlaceId) return fail(400, { error: "place.google_place_id is required" });
  if (!name) return fail(400, { error: "place.name is required" });
  const status = CONTENT_STATUSES.has(contentStatus) ? contentStatus : "ready";

  // ── Idempotency: already onboarded? (read the joined view) ──
  const { data: existing } = await admin
    .from("projects_view")
    .select("id, slug, name, status, listing_type")
    .eq("google_place_id", googlePlaceId)
    .maybeSingle();
  if (existing) {
    return fail(409, {
      code: "place_already_exists",
      error: "This place is already on Mesita. If you manage it, contact support to claim ownership.",
      existing,
    });
  }

  // ── Unique slug against the live catalog ──
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
    // Race guard: a concurrent create won the unique index — report as dup.
    if (placeErr?.code === "23505" && /google_place_id/.test(placeErr.message)) {
      const after = await admin
        .from("projects_view")
        .select("id, slug, name, status, listing_type")
        .eq("google_place_id", googlePlaceId)
        .maybeSingle();
      return fail(409, {
        code: "place_already_exists",
        error: "This place is already on Mesita. If you manage it, contact support to claim ownership.",
        existing: after.data ?? null,
      });
    }
    return fail(400, {
      error: `place_insert: ${placeErr?.message ?? "no row"}`,
      code: placeErr?.code ?? null,
    });
  }

  // ── 2) projects (entity, shared PK). content_status is caller-supplied. ──
  const { data: unitRow, error: unitErr } = await admin
    .from("projects")
    .insert({
      id: placeRow.id,
      slug,
      status: "active",
      listing_type: "web",
      content_status: status,
    })
    .select("id, slug, status")
    .single();
  if (unitErr || !unitRow) {
    // Compensate: drop the orphan place so a failed create leaves nothing.
    await admin.from("places").delete().eq("id", placeRow.id);
    if (unitErr?.code === "23505" && /\bslug\b/.test(unitErr.message)) {
      return fail(409, {
        code: "slug_already_taken",
        error: "A place with this URL slug already exists. Try again.",
      });
    }
    return fail(400, {
      error: `unit_insert: ${unitErr?.message ?? "no row"}`,
      code: unitErr?.code ?? null,
    });
  }

  return {
    ok: true,
    saved: {
      unit_id: unitRow.id,
      place_id: placeRow.id,
      slug: unitRow.slug,
      name,
      status: unitRow.status,
    },
  };
}
