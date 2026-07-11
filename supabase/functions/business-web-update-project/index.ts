// Supabase Edge Function — business-web-update-project
//
// Authenticated. Updates editable fields on a place the caller owns or
// manages. Self-contained: verifies the JWT, checks project_members membership
// itself, validates input, writes via service role. Does NOT call any other
// Edge Function.
//
// Local:  supabase functions serve business-web-update-project
// Deploy: supabase functions deploy business-web-update-project

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { isEmailish } from "../_shared/input.ts";
import { PLACE_BUSINESS_COLUMNS } from "../_shared/place-columns.ts";
import {
  inferPlaceCategory,
  type PlaceCategory,
} from "../_shared/categories.ts";
import { ENRICH_FIELD_LIMITS } from "../_shared/enrich-field-limits.ts";
import { sanitizePlaceTags } from "../_shared/tags.ts";

const MAX_PHOTOS = ENRICH_FIELD_LIMITS.photos.max;
const MAX_TAGS = ENRICH_FIELD_LIMITS.tagsPerPlace.max;
const MAX_TAG_LEN = ENRICH_FIELD_LIMITS.tagSlugLength.max;
// Matches the business Place editor's About field cap (PLACE_DESCRIPTION_MAX).
const MAX_DESCRIPTION_LEN = 2000;

type UpdateBody = {
  id?: string;
  name?: string | null;
  category?: string | null;
  vibe?: string | null;
  // NOTE: `price_level` is deliberately NOT editable here. It is inferred
  // from Google Places during Enrich-Research and must not be overridden
  // by admin, business, or any client.
  // ISO 4217 code. Mesita defaults every place to MXN; the business
  // can switch to USD/EUR/etc. only when we extend coverage outside
  // Mexico. Kept as text so the EF doesn't hard-code an enum.
  currency?: string | null;
  status?: "active" | "paused" | "archived";
  fiscal_type?: "formal" | "informal";
  // NOTE: `plan` is deliberately NOT editable here. Plan changes are billing
  // and go through business-web-change-subscription (Stripe), so a client can't
  // grant itself Pro/Ultra with a plain profile update.
  // NOTE: `address` is native (Google/Enricher-sourced) and deliberately NOT
  // editable here — kept in the type only so stale clients get the reject.
  address?: string | null;
  closes_at?: string | null;
  hours?: PlaceHours | null;
  phone?: string | null;
  pitch?: string | null;
  story?: string | null;
  // Four per-tier promo rates (migration 0032). Welcome variants fire on a
  // guest's first visit at the place; the unprefixed variants apply on every
  // visit afterwards. DB constraint enforces the legal set {10, 20, 50, 70}.
  welcome_free_rate?: number | null;
  welcome_premium_rate?: number | null;
  free_rate?: number | null;
  premium_rate?: number | null;
  // Place-level monthly promo spend cap (migration 0038), in the place's
  // currency. One of 200, 500, 1000, 2000 or null (no cap).
  monthly_promo_cap?: number | null;
  photos?: string[];
  // External + social channels
  website_url?: string | null;
  instagram_url?: string | null;
  tiktok_url?: string | null;
  facebook_url?: string | null;
  whatsapp_url?: string | null;
  opentable_url?: string | null;
  resy_url?: string | null;
  uber_eats_url?: string | null;
  x_url?: string | null;
  threads_url?: string | null;
  reddit_url?: string | null;
  didi_food_url?: string | null;
  tripadvisor_url?: string | null;
  google_maps_url?: string | null;
  // Plain contact (not URL-shaped)
  email?: string | null;
  // Reservationist booking target (any POS / booking URL) + multi-contacts.
  reservation_endpoint?: string | null;
  reservation_contacts?: ReservationContact[] | null;
  // Place-redesign editable surface (Business-E=YES on the Components spec).
  description?: string | null;
  menu_pdf_url?: string | null;
  // Optional human label paired with menu_pdf_url. Null clears.
  menu_pdf_name?: string | null;
  // Alias fields used by the products-first UI.
  product_catalog_url?: string | null;
  product_catalog_name?: string | null;
  // Generic products payload. Menu is one subtype under products.menu.
  products?: { menu?: unknown[] | null } | null;
  tags?: string[];
  // Promos page section toggles — Basic + Advanced segmentation can be
  // collapsed by the business. Defaults align with the migration: basic
  // on, advanced off.
  segmentation_basic_enabled?: boolean;
  segmentation_advanced_enabled?: boolean;
};

type HoursRange = { open: string; close: string };
type DayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";
type PlaceHours = Partial<Record<DayKey, HoursRange[]>>;

/** One person the reservationist can call/message when booking. */
type ReservationContact = {
  name: string;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
};

const MAX_RESERVATION_CONTACTS = 8;

const DAY_KEYS: DayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

const URL_FIELDS = [
  "website_url",
  "instagram_url",
  "tiktok_url",
  "facebook_url",
  "whatsapp_url",
  "opentable_url",
  "resy_url",
  "uber_eats_url",
  "x_url",
  "threads_url",
  "reddit_url",
  "didi_food_url",
  "tripadvisor_url",
  "google_maps_url",
] as const;
type UrlField = (typeof URL_FIELDS)[number];

const EDITABLE_STATUSES = new Set(["active", "paused", "archived"]);
const OPENAI_KEY = Deno.env.get("OPENAI_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);

  // Parse + validate.
  const bodyRes = await readJson<UpdateBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const projectId = (body.id ?? "").toString().trim();
  if (!projectId) return json({ ok: false, error: "id is required" }, 400);

  // Auth: caller must be a member of this place. Super-admins bypass via
  // the super_admins allowlist baked into requireMembership.
  const memberRes = await requireMembership(admin, authRes.user, projectId);
  if (!memberRes.ok) return memberRes.response;

  // Build the update payload from the whitelist. Missing keys are not
  // touched. Explicit null clears the field.
  const update: Record<string, unknown> = {};
  if ("name" in body) {
    const n = (body.name ?? "").toString().trim();
    if (!n) return json({ ok: false, error: "name cannot be empty" }, 400);
    if (n.length > ENRICH_FIELD_LIMITS.placeName.max) {
      return json({ ok: false, error: "name too long" }, 400);
    }
    update.name = n;
  }
  if ("category" in body) {
    const resolved = await resolveCategoryInput(admin, body.category, OPENAI_KEY);
    if (!resolved.ok) {
      return json({ ok: false, error: resolved.error }, 400);
    }
    update.category = resolved.slug;
    update.category_label = resolved.label;
  }
  if ("vibe" in body) update.vibe = optString(body.vibe, 80);
  if ("price_level" in body) {
    // Price is enrich-only (Google Places). Reject so stale clients learn
    // the contract — same posture as `plan` via billing.
    return json(
      {
        ok: false,
        code: "price_via_enrich",
        error:
          "price_level is set by Enrich-Research from Google Places and cannot be updated manually.",
      },
      400,
    );
  }
  // currency: ISO 4217 uppercase code, 3 chars. Reject anything else
  // — accidental empty strings or longer strings would corrupt every
  // monetary render downstream.
  if ("currency" in body) {
    const c = (body.currency ?? "").toString().trim().toUpperCase();
    if (c.length === 3 && /^[A-Z]{3}$/.test(c)) update.currency = c;
  }
  if ("status" in body) {
    const s = body.status;
    if (!s || !EDITABLE_STATUSES.has(s)) {
      return json({ ok: false, error: "status must be active|paused|archived" }, 400);
    }
    update.status = s;
  }
  if ("fiscal_type" in body) {
    const f = body.fiscal_type;
    if (f !== "formal" && f !== "informal") {
      return json(
        { ok: false, error: "fiscal_type must be 'formal' or 'informal'" },
        400,
      );
    }
    update.fiscal_type = f;
  }
  if ("plan" in body) {
    // Plan is billing, not profile: reject instead of silently ignoring so a
    // stale client learns the contract moved to business-web-change-subscription.
    return json(
      {
        ok: false,
        code: "plan_via_billing",
        error: "plan is managed by business-web-change-subscription (Stripe), not by profile updates.",
      },
      400,
    );
  }
  if ("address" in body) {
    // Address is native — seeded from Google Places and refined by the
    // Enricher, which writes public.places directly. Reject so stale clients
    // learn the contract — same posture as `price_level` and `plan`.
    return json(
      {
        ok: false,
        code: "address_via_enrich",
        error:
          "address is set from Google Places / the Enricher and cannot be updated manually.",
      },
      400,
    );
  }
  if ("closes_at" in body) {
    const raw = optString(body.closes_at, 5);
    if (raw != null && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(raw)) {
      return json(
        { ok: false, error: "closes_at must be 24h HH:MM (e.g. 02:00)" },
        400,
      );
    }
    update.closes_at = raw;
  }
  if ("hours" in body) {
    const cleaned = sanitiseHours(body.hours);
    if (cleaned === "invalid") {
      return json(
        { ok: false, error: "hours must be a map of weekday → [{open,close}] with HH:MM values" },
        400,
      );
    }
    update.hours = cleaned;
  }
  if ("phone" in body) {
    const raw = optString(body.phone, 40);
    // Phones ALWAYS carry a country code (E.164-style prefix). Null/empty
    // still clears; anything else must start with "+".
    if (raw != null && !/^\+[0-9]/.test(raw)) {
      return json(
        {
          ok: false,
          code: "phone_needs_country_code",
          error: "phone must include a country code, e.g. +52 81 8378 2164.",
        },
        400,
      );
    }
    update.phone = raw;
  }
  if ("pitch" in body) update.pitch = optString(body.pitch, 200);
  if ("story" in body) update.story = optString(body.story, 1500);
  // Four per-tier promo rates. Each is nullable (null clears the offer) or
  // one of {10, 20, 50, 70}. The DB has a matching CHECK constraint so a
  // mis-shaped client can't slip through; this is the friendly 400 layer.
  const PROMO_RATE_FIELDS = [
    "welcome_free_rate",
    "welcome_premium_rate",
    "free_rate",
    "premium_rate",
  ] as const;
  const LEGAL_PROMO_RATES = new Set([10, 20, 50, 70]);
  for (const field of PROMO_RATE_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw == null) {
      update[field] = null;
      continue;
    }
    const v = Number(raw);
    if (!LEGAL_PROMO_RATES.has(v)) {
      return json(
        { ok: false, error: `${field} must be null or one of 10, 20, 50, 70` },
        400,
      );
    }
    update[field] = v;
  }

  // Monthly promo spend cap. Nullable (null clears the ceiling) or one of
  // {200, 500, 1000, 2000}. DB CHECK mirrors this; this is the friendly 400.
  if ("monthly_promo_cap" in body) {
    const raw = body.monthly_promo_cap;
    if (raw == null) {
      update.monthly_promo_cap = null;
    } else {
      const v = Number(raw);
      if (![200, 500, 1000, 2000].includes(v)) {
        return json(
          { ok: false, error: "monthly_promo_cap must be null or one of 200, 500, 1000, 2000" },
          400,
        );
      }
      update.monthly_promo_cap = v;
    }
  }
  if ("photos" in body) {
    if (!Array.isArray(body.photos)) {
      return json({ ok: false, error: "photos must be an array of URL strings" }, 400);
    }
    const clean = body.photos.filter(isUrl).slice(0, MAX_PHOTOS);
    update.photos = clean;
  }

  // External + social URLs — each optional, each validated to https://.
  for (const field of URL_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field as UrlField];
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      update[field] = null;
      continue;
    }
    if (!isUrl(raw)) {
      return json({ ok: false, error: `${field} must be a valid https:// URL` }, 400);
    }
    update[field] = raw.trim();
  }

  // Place-redesign editable fields.
  if ("description" in body) {
    update.description = optString(body.description, MAX_DESCRIPTION_LEN);
  }
  if ("menu_pdf_url" in body) {
    const raw = body.menu_pdf_url;
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      update.menu_pdf_url = null;
    } else if (!isUrl(raw)) {
      return json({ ok: false, error: "menu_pdf_url must be a valid https:// URL" }, 400);
    } else {
      update.menu_pdf_url = raw.trim();
    }
  }
  if ("product_catalog_url" in body) {
    const raw = body.product_catalog_url;
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      update.menu_pdf_url = null;
    } else if (!isUrl(raw)) {
      return json({ ok: false, error: "product_catalog_url must be a valid https:// URL" }, 400);
    } else {
      update.menu_pdf_url = raw.trim();
    }
  }
  if ("menu_pdf_name" in body) {
    update.menu_pdf_name = optString(body.menu_pdf_name, 80);
  }
  if ("product_catalog_name" in body) {
    update.menu_pdf_name = optString(body.product_catalog_name, 80);
  }
  if ("products" in body) {
    const p = body.products;
    if (p == null) {
      update.products = null;
    } else if (typeof p !== "object" || Array.isArray(p)) {
      return json({ ok: false, error: "products must be an object or null" }, 400);
    } else {
      const menu = (p as { menu?: unknown }).menu;
      if (menu != null && !Array.isArray(menu)) {
        return json({ ok: false, error: "products.menu must be an array or null" }, 400);
      }
      update.products = p;
      // Keep legacy menus in sync while consumers/business migrate.
      if (Array.isArray(menu)) update.menus = menu;
    }
  }
  if ("tags" in body) {
    if (!Array.isArray(body.tags)) {
      return json({ ok: false, error: "tags must be an array of strings" }, 400);
    }
    // Lowercase + trim + dedupe in one pass. Empty entries drop out so the
    // form can submit a partially typed list without rejecting the request.
    // Then strip mutually exclusive catalog pairs (same rules as Enricher).
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const t of body.tags) {
      if (typeof t !== "string") continue;
      const norm = t.trim().toLowerCase().slice(0, MAX_TAG_LEN);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      clean.push(norm);
      if (clean.length >= MAX_TAGS) break;
    }
    update.tags = sanitizePlaceTags(clean).slice(0, MAX_TAGS);
  }
  // Promos section toggles. Strict boolean only — silently coerce
  // truthy / "true" strings would let stale clients write garbage.
  for (const boolField of [
    "segmentation_basic_enabled",
    "segmentation_advanced_enabled",
  ] as const) {
    if (!(boolField in body)) continue;
    const value = body[boolField];
    if (typeof value !== "boolean") {
      return json({ ok: false, error: `${boolField} must be boolean` }, 400);
    }
    update[boolField] = value;
  }

  // Email: not a URL. Just trim + sanity-check the shape (has @ and a dot
  // after it). Empty / null clears the field.
  if ("email" in body) {
    const raw = body.email;
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      update.email = null;
    } else if (typeof raw !== "string") {
      return json({ ok: false, error: "email must be a string" }, 400);
    } else {
      const trimmed = raw.trim();
      if (!isEmailish(trimmed)) {
        return json({ ok: false, error: "email must look like name@domain.tld" }, 400);
      }
      if (trimmed.length > 254) {
        return json({ ok: false, error: "email too long" }, 400);
      }
      update.email = trimmed.toLowerCase();
    }
  }

  // Custom POS / booking endpoint — any https URL (or deep link). Empty clears.
  if ("reservation_endpoint" in body) {
    const raw = body.reservation_endpoint;
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      update.reservation_endpoint = null;
    } else if (typeof raw !== "string") {
      return json({ ok: false, error: "reservation_endpoint must be a string" }, 400);
    } else {
      const trimmed = raw.trim().slice(0, 500);
      // Allow https://… and common deep-link schemes the reservationist may dial.
      if (!isReservationEndpoint(trimmed)) {
        return json(
          {
            ok: false,
            error:
              "reservation_endpoint must be an https:// URL or a tel:/mailto:/sms: deep link",
          },
          400,
        );
      }
      update.reservation_endpoint = trimmed;
    }
  }

  // Multi-contact list for the reservationist. Empty array clears.
  if ("reservation_contacts" in body) {
    const cleaned = sanitiseReservationContacts(body.reservation_contacts);
    if (cleaned === "invalid") {
      return json(
        {
          ok: false,
          error:
            "reservation_contacts must be an array of {name, role?, phone?, email?, notes?} (max 8)",
        },
        400,
      );
    }
    update.reservation_contacts = cleaned;
  }

  if (Object.keys(update).length === 0) {
    return json({ ok: false, error: "No editable fields provided" }, 400);
  }

  let { data: place, error: updateError } = await admin
    .from("projects_view")
    .update(update)
    .eq("id", projectId)
    .select(PLACE_BUSINESS_COLUMNS)
    .single();

  // Backward compatibility: in projects where category_label migration hasn't
  // landed (or schema cache is stale), retry the same update without
  // category_label so edits can still be saved.
  if (updateError && isMissingCategoryLabelColumnError(updateError) && "category_label" in update) {
    const retryUpdate = { ...update };
    delete retryUpdate.category_label;
    const retry = await admin
      .from("projects_view")
      .update(retryUpdate)
      .eq("id", projectId)
      .select(PLACE_BUSINESS_COLUMNS)
      .single();
    place = retry.data;
    updateError = retry.error;
  }
  if (updateError) {
    return json(
      { ok: false, error: `place_update: ${updateError.message}`, code: updateError.code ?? null },
      400,
    );
  }

  return json({ ok: true, place });
});

async function resolveCategoryInput(
  admin: ReturnType<typeof adminClient>,
  input: unknown,
  openaiKey: string | undefined,
): Promise<
  | { ok: true; slug: string | null; label: string | null }
  | { ok: false; error: string }
> {
  const raw = optString(input, 120);
  if (raw == null) {
    return { ok: true, slug: null, label: null };
  }
  const { data, error } = await admin
    .from("place_categories")
    .select("slug, label");
  if (error) {
    return { ok: false, error: `category_lookup: ${error.message}` };
  }
  const categories = (data ?? []) as PlaceCategory[];
  const needle = raw.trim().toLowerCase();
  const hit = categories.find(
    (c) => c.slug.toLowerCase() === needle || c.label.toLowerCase() === needle,
  );
  if (hit) return { ok: true, slug: hit.slug, label: hit.label };

  // NLP fallback: map free-form/Google category text to the closest Mesita
  // category slug instead of requiring exact text equality.
  const inferredSlug = await inferPlaceCategory(openaiKey, categories, {
    name: raw,
    googlePrimaryType: raw,
    googlePrimaryTypeDisplay: raw,
  });
  if (inferredSlug) {
    const inferredHit = categories.find((c) => c.slug === inferredSlug);
    if (inferredHit) return { ok: true, slug: inferredHit.slug, label: inferredHit.label };
  }

  return {
    ok: false,
    error:
      "category could not be mapped to a Mesita category. Try a clearer category name.",
  };
}

function isMissingCategoryLabelColumnError(err: { message?: string } | null): boolean {
  if (!err?.message) return false;
  return (
    err.message.includes("category_label") &&
    (err.message.includes("schema cache") || err.message.includes("column"))
  );
}

function optString(v: unknown, maxLen: number): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

// "invalid" is the only failure sentinel so the caller can return a single
// 400. Null means the business intentionally cleared their hours. Empty object
// is permitted — the place is open zero days.
function sanitiseHours(v: unknown): PlaceHours | null | "invalid" {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return "invalid";
  const input = v as Record<string, unknown>;
  const out: PlaceHours = {};
  for (const day of DAY_KEYS) {
    if (!(day in input)) continue;
    const ranges = input[day];
    if (ranges == null) continue;
    if (!Array.isArray(ranges)) return "invalid";
    const cleanRanges: HoursRange[] = [];
    for (const r of ranges) {
      if (!r || typeof r !== "object") return "invalid";
      const open = (r as { open?: unknown }).open;
      const close = (r as { close?: unknown }).close;
      if (typeof open !== "string" || typeof close !== "string") return "invalid";
      if (!HHMM_RE.test(open) || !HHMM_RE.test(close)) return "invalid";
      cleanRanges.push({ open, close });
    }
    if (cleanRanges.length > 0) out[day] = cleanRanges;
  }
  return out;
}

function isUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    // Require https — http:// breaks mixed-content guards in the browser.
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/** POS / booking endpoint: https URL or a phone/email deep link. */
function isReservationEndpoint(v: string): boolean {
  try {
    const u = new URL(v);
    return (
      u.protocol === "https:" ||
      u.protocol === "tel:" ||
      u.protocol === "mailto:" ||
      u.protocol === "sms:"
    );
  } catch {
    return false;
  }
}

function sanitiseReservationContacts(
  v: unknown,
): ReservationContact[] | "invalid" {
  if (v == null) return [];
  if (!Array.isArray(v)) return "invalid";
  if (v.length > MAX_RESERVATION_CONTACTS) return "invalid";
  const out: ReservationContact[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
    const row = raw as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 80) : "";
    if (!name) return "invalid";
    const role =
      typeof row.role === "string" && row.role.trim()
        ? row.role.trim().slice(0, 60)
        : null;
    const phone =
      typeof row.phone === "string" && row.phone.trim()
        ? row.phone.trim().slice(0, 40)
        : null;
    let email: string | null = null;
    if (typeof row.email === "string" && row.email.trim()) {
      const e = row.email.trim().toLowerCase().slice(0, 254);
      if (!isEmailish(e)) return "invalid";
      email = e;
    }
    const notes =
      typeof row.notes === "string" && row.notes.trim()
        ? row.notes.trim().slice(0, 200)
        : null;
    if (!phone && !email) return "invalid";
    out.push({ name, role, phone, email, notes });
  }
  return out;
}

