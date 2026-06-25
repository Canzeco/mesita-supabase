// Supabase Edge Function — atlas-seed-place (artificial caller / agent)
//
// The SYNCHRONOUS "Pre-ADEA" seed. Natural callers (business-create-unit,
// and later admin/consumer create paths) hand this agent a Google Places
// `placeId`; it fetches Google Places BASICS ONLY (name, address, geo,
// category, phone, hours, first photos), inserts the venue row with
// adea_status='generating', seeds the Mesita + Google identity links
// (slug/name + channel columns + google_place_id/google_maps_url), and
// returns { id, slug } — instantly. It is idempotent on google_place_id.
//
// What it DELIBERATELY does NOT do: Firecrawl, Perplexity, OpenAI synthesis,
// Google CSE images, Instagram scraping. All of that is the heavy/redundant
// path — atlas-enrich-place re-does every bit of it in its own tier pipeline,
// so create-time copies would just duplicate work and add latency. The
// enricher runs asynchronously after this seed returns.
//
// NOTIFICATION: there is NO dedicated venue-lifecycle notifications table —
// the admin feed (admin-list-notifications) DERIVES atlas.venue_created from
// venues.created_at (auto-stamped on insert). So the INSERT below IS the
// 'place seeded' notification; no extra emit/insert is needed (and we must
// NOT stamp enriched_at, which would prematurely fire venue_enriched).
//
// Agent contract: verify_jwt=false; requireInternalCaller gates the
// service-role bearer (service-role only — NO getAuthedUser). Mirrors how
// atlas-enrich-place is gated.
//
// Local:  supabase functions serve atlas-seed-place
// Deploy: supabase functions deploy atlas-seed-place

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import { ensureUniqueSlug, slugify } from "../_shared/venue-slug.ts";
import { classifyLinks } from "../_shared/channels.ts";
import { humanizeCategorySlug } from "../_shared/parse-utils.ts";
import { ATLAS_FIELD_LIMITS } from "../_shared/atlas-field-limits.ts";

const GOOGLE_FIELD_MASK = [
  "id",
  "displayName",
  "primaryType",
  "primaryTypeDisplayName",
  "types",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "formattedAddress",
  "addressComponents",
  "location",
  "rating",
  "userRatingCount",
  "googleMapsUri",
  "websiteUri",
  "regularOpeningHours",
  "currentOpeningHours",
  "priceLevel",
  "businessStatus",
  "editorialSummary",
  "generativeSummary",
  "reviewSummary",
  "reviews",
  "photos",
].join(",");

// Sourcing budget: how many candidate photo URLs we collect from Google
// Places before any quality pass. (Seed uses Places only — no CSE/Firecrawl.)
const MAX_PHOTOS = 20;
// What we actually persist as the immediate seed gallery. The swipe-card cover
// and gallery only show a handful, so we keep the first 10. atlas-enrich-place
// re-gathers, vision-ranks and re-sorts this set right after seed.
const MAX_PHOTOS_TO_KEEP = 10;

type EnrichBody = { placeId?: string };

// Google's regularOpeningHours.periods shape. `day` is 0..6 with Sunday = 0
// (matches JS Date.getDay()). A "24/7" venue returns a single period with an
// `open` but no `close`. Overnight ranges show up as open.day = N, close.day
// = N+1, which is what weeklyHoursFromPeriods has to handle.
type GooglePeriod = {
  open?: { day?: number; hour?: number; minute?: number };
  close?: { day?: number; hour?: number; minute?: number };
};

// Persisted shape for venues.hours (jsonb). Lowercase English day keys;
// closed days are simply omitted. Multiple ranges per day cover split
// shifts (lunch + dinner). Overnight ranges live on the opening day with
// `close <= open` semantically meaning the close time is the next day —
// a single entry per overnight shift, not a Mon-23:59 + Tue-00:00 pair.
type WeeklyHours = Partial<Record<DayKey, { open: string; close: string }[]>>;
type DayKey =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";
const DAY_KEYS: DayKey[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

type GoogleDetails = {
  id?: string;
  displayName?: { text?: string };
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  formattedAddress?: string;
  addressComponents?: { types?: string[]; longText?: string }[];
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  websiteUri?: string;
  googleMapsUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[]; periods?: GooglePeriod[] };
  currentOpeningHours?: { weekdayDescriptions?: string[]; periods?: GooglePeriod[] };
  priceLevel?: string;
  businessStatus?: string;
  editorialSummary?: { text?: string };
  generativeSummary?: { overview?: { text?: string }; description?: { text?: string } };
  reviewSummary?: { text?: { text?: string } };
  // Up to 5 real reviews from Google Place Details. Mapped into the
  // google_reviews jsonb column — real authors/ratings/quotes only.
  reviews?: {
    rating?: number;
    text?: { text?: string };
    originalText?: { text?: string };
    relativePublishTimeDescription?: string;
    authorAttribution?: { displayName?: string };
  }[];
  photos?: { name?: string; widthPx?: number; heightPx?: number; authorAttributions?: { displayName?: string }[] }[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Service-role only — gated exactly like atlas-enrich-place. NO getAuthedUser:
  // the natural caller (business-create-unit) has already authenticated the end
  // user and verified business ownership before delegating the seed here.
  const callerRes = requireInternalCaller(req, env);
  if (!callerRes.ok) return callerRes.response;

  // Google Maps Platform key. Cloud secret is GMP_KEY; SUPA_GMP_KEY kept as a
  // fallback for older environments that haven't been renamed yet. The seed
  // reads NO third-party heavy-pipeline keys (Firecrawl/Perplexity/OpenAI/CSE)
  // — that work belongs to atlas-enrich-place.
  const GOOGLE_KEY = Deno.env.get("GMP_KEY") ?? Deno.env.get("SUPA_GMP_KEY");
  if (!GOOGLE_KEY) {
    return json({ ok: false, error: "Server misconfigured (missing core secrets)" }, 500);
  }

  // Parse input. Same contract as business-create-unit today.
  const bodyRes = await readJson<EnrichBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  // ── Pre-flight dedupe (idempotency on google_place_id) ───────────────
  // Cheap SELECT before we spend Google quota / insert a row for a venue
  // that's already onboarded. The insert below still catches the race
  // (unique constraint on google_place_id) — this is just an optimisation
  // for the common "business clicks twice" case. Service role: RLS would
  // hide pending_review / paused / archived rows from the anon path and we
  // want to detect them all.
  const admin = adminClient(env);
  const { data: existingByPlaceId } = await admin
    .from("venues")
    .select("id, slug, name, status, listing_type")
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (existingByPlaceId) {
    return json(
      {
        ok: false,
        code: "venue_already_exists",
        error:
          "This venue is already on Mesita. If you manage it, contact support to claim ownership.",
        existing: existingByPlaceId,
      },
      409,
    );
  }

  // ── Step 1: Google Places details (blocking — everything else needs it) ──
  const details = await fetchGoogleDetails(placeId, GOOGLE_KEY);
  if ("error" in details) {
    // Surface transient Google outages as 503 so the operator UI can
    // distinguish them from a genuine bad-request (502). Body carries
    // the pre-classified friendly message; no raw JSON is bubbled up.
    return json(
      { ok: false, code: details.transient ? "google_unavailable" : "google_error", error: details.error },
      details.transient ? 503 : 502,
    );
  }

  // Google Business is the spine: a venue that Google can't give a name,
  // coordinates, and an address for is not a real listing and must NOT enter
  // Mesita. These fields are non-nullable on the profile — reject here rather
  // than inserting a half-null row the consumer app then has to special-case.
  const venueName = details.displayName?.text ?? "";
  if (!venueName) {
    return json(
      { ok: false, code: "google_spine_incomplete", error: "Place has no display name on Google — can't list it." },
      422,
    );
  }
  if (details.location?.latitude == null || details.location?.longitude == null) {
    return json(
      { ok: false, code: "google_spine_incomplete", error: "Place has no coordinates on Google — can't list it." },
      422,
    );
  }
  const address = details.formattedAddress ?? null;
  if (!address) {
    return json(
      { ok: false, code: "google_spine_incomplete", error: "Place has no address on Google — can't list it." },
      422,
    );
  }
  const city = findAddressComponent(details.addressComponents, ["locality", "administrative_area_level_2"]);
  const country = findAddressComponent(details.addressComponents, ["country"]);

  // ── Step 2: Photos + timezone ONLY (best-effort, may individually fail) ──
  // Google Places photos are the immediate seed gallery so the venue has
  // images the instant it's created. No CSE/Firecrawl image sources here —
  // atlas-enrich-place owns the full image funnel and re-orders this set.
  const [placesPhotosResult, timezoneResult] = await Promise.allSettled([
    fetchGooglePhotos(details.photos ?? [], MAX_PHOTOS, GOOGLE_KEY),
    fetchTimezone(details.location?.latitude, details.location?.longitude, GOOGLE_KEY),
  ]);
  const placesPhotos = placesPhotosResult.status === "fulfilled" ? placesPhotosResult.value : [];
  const timezone = timezoneResult.status === "fulfilled" ? timezoneResult.value : null;

  // Seed gallery: Google Places photo URLs in Google order, capped at the
  // keep budget. atlas-enrich-place re-gathers + vision-ranks asynchronously.
  const photoUrls = placesPhotos.map((p) => p.photoUri).filter(Boolean).slice(0, MAX_PHOTOS_TO_KEEP);

  // ── Channel extraction — Google-derived identity links only ──
  // Classify Google's websiteUri + googleMapsUri into our flat channel
  // columns. No Firecrawl links (we never scraped a site here), so no email
  // either — atlas-enrich-place fills email/socials via its link-discovery tier.
  const channels = classifyLinks([details.websiteUri, details.googleMapsUri]);
  const email = null;

  // ── Category from Google with NO OpenAI ──
  // Cheap placeholder derived from Google's primary type. atlas-enrich-place
  // re-infers the real category via inferVenueCategory and overwrites it.
  const resolvedCategorySlug =
    slugify(details.primaryTypeDisplayName?.text ?? details.primaryType ?? "") || null;
  const resolvedCategoryLabel = resolvedCategorySlug
    ? humanizeCategorySlug(resolvedCategorySlug)
    : null;

  // ── Slug (replaces the old OpenAI-synth slug source) ──
  const slug = await ensureUniqueSlug(admin, slugify(venueName));

  // Normalised weekly schedule for venues.hours (jsonb). Built from Google's
  // regularOpeningHours.periods; null when the place is permanently closed
  // or Google has no hours data.
  const hours = weeklyHoursFromPeriods(details.regularOpeningHours?.periods);
  const closesAt = closesAtFromHours(details.regularOpeningHours?.weekdayDescriptions ?? []);

  const insertRow = {
    name: venueName.slice(0, ATLAS_FIELD_LIMITS.venueName.max),
    slug,
    category: resolvedCategorySlug,
    category_label: resolvedCategoryLabel ?? humanizeCategorySlug(resolvedCategorySlug),
    // Synth-only field; enrich fills the real vibe.
    vibe: null,
    price_level: priceLevelFromGoogle(details.priceLevel),
    // Created venues are publicly discoverable but not yet claimed by
    // anyone. RLS shows status in ('active','lead'); ticket creation
    // gates on listing_type='partner' so unclaimed web listings stay
    // bookable-blocked until the owner verifies + upgrades. The owning
    // venue_members row is NOT created here — that only lands when
    // admin-decide-verification approves an ownership claim.
    listing_type: "web" as const,
    status: "active" as const,
    // ADEA lifecycle: this seed is the SINGLE create-time writer of
    // 'generating'. atlas-enrich-place keeps it 'generating' while working,
    // then lands 'ready' (or the caller marks 'failed'). The public select
    // RLS policy only exposes 'ready' venues, so the listing stays hidden
    // from consumers until enrichment lands.
    adea_status: "generating" as const,
    lat: details.location?.latitude ?? null,
    lng: details.location?.longitude ?? null,
    address,
    timezone,
    closes_at: closesAt,
    hours,
    phone: details.nationalPhoneNumber ?? details.internationalPhoneNumber ?? null,
    // country is the long-form name Google returns ("Mexico",
    // "United States", etc.). The lookup EF normalises this into a
    // region bucket so the manual-fallback card can pick the right
    // contact channel (WhatsApp for LatAm, SMS for US, email floor).
    country,
    // Cheap Google-derived placeholders; atlas-enrich-place overwrites both
    // with grounded synthesis.
    pitch: details.editorialSummary?.text ?? null,
    story: details.generativeSummary?.overview?.text ?? null,
    photos: photoUrls,
    google_place_id: details.id ?? placeId,
    // Every channel below is best-effort and may be null. classifyLinks
    // picks the shortest matching URL per host so we land profile roots
    // instead of post-deep-links.
    website_url: channels.website_url,
    instagram_url: channels.instagram_url,
    facebook_url: channels.facebook_url,
    tiktok_url: channels.tiktok_url,
    x_url: channels.x_url,
    threads_url: channels.threads_url,
    reddit_url: channels.reddit_url,
    whatsapp_url: channels.whatsapp_url,
    opentable_url: channels.opentable_url,
    resy_url: channels.resy_url,
    uber_eats_url: channels.uber_eats_url,
    didi_food_url: channels.didi_food_url,
    tripadvisor_url: channels.tripadvisor_url,
    yelp_url: channels.yelp_url,
    google_maps_url: channels.google_maps_url,
    email,
    // Signal columns surfaced on the Place page's Signals tiles. The
    // mesita_* counterparts are populated by aggregation jobs later; the
    // Google values come straight from this seed. instagram_followers_count
    // is filled by atlas-enrich-place (it scrapes the IG profile).
    google_stars_overall: details.rating ?? null,
    google_review_count: details.userRatingCount ?? null,
    // Real reviews straight from Google Place Details (up to 5). Qualitative
    // profile fields (details{}, summary, products, popular_times) are filled
    // separately by the atlas-enrich-place agent after insert.
    google_reviews: mapGoogleReviews(details.reviews),
    editorial_summary: details.editorialSummary?.text ?? null,
    instagram_followers_count: null,
  };

  // ── Step 3: Persist (service role; RLS allows reads only) ──
  // The INSERT itself IS the 'place seeded' notification: there is NO dedicated
  // venue-lifecycle notifications table — admin-list-notifications DERIVES
  // atlas.venue_created from venues.created_at (auto-stamped on insert). We do
  // NOT stamp enriched_at here (that would prematurely fire venue_enriched) and
  // do NOT touch consumer_pay_notifications (that is the consumer ticket inbox).
  let { data: venue, error: venueError } = await admin
    .from("venues")
    .insert(insertRow)
    .select("id, slug, name, status")
    .single();

  // Backward compatibility: some remote projects may still be warming schema
  // cache or missing the category_label column migration. Retry without that
  // field so venue creation remains available.
  if (venueError && isMissingCategoryLabelColumnError(venueError)) {
    const { category_label: _ignored, ...legacyInsertRow } = insertRow;
    const retry = await admin
      .from("venues")
      .insert(legacyInsertRow)
      .select("id, slug, name, status")
      .single();
    venue = retry.data;
    venueError = retry.error;
  }
  // yelp_url is the newest venue column (migration 20260625140000). A project
  // that hasn't applied it yet — or whose PostgREST schema cache hasn't reloaded
  // — would otherwise fail the WHOLE insert on the unknown column. Strip it and
  // retry so venue creation degrades gracefully until the migration lands.
  if (venueError && isMissingYelpUrlColumnError(venueError)) {
    const { yelp_url: _ignored, ...legacyInsertRow } = insertRow;
    const retry = await admin
      .from("venues")
      .insert(legacyInsertRow)
      .select("id, slug, name, status")
      .single();
    venue = retry.data;
    venueError = retry.error;
  }
  if (venueError) {
    // Unique-violation on google_place_id → already onboarded by someone.
    if (venueError.code === "23505" && /google_place_id/.test(venueError.message)) {
      const existing = await admin
        .from("venues")
        .select("id, slug, name, status, listing_type")
        .eq("google_place_id", details.id ?? placeId)
        .maybeSingle();
      return json(
        {
          ok: false,
          code: "venue_already_exists",
          error:
            "This venue is already on Mesita. If you manage it, contact support to claim ownership.",
          existing: existing.data ?? null,
        },
        409,
      );
    }
    // Unique-violation on slug → very likely two venues with the same name.
    if (venueError.code === "23505" && /\bslug\b/.test(venueError.message)) {
      return json(
        {
          ok: false,
          code: "slug_already_taken",
          error:
            "A venue with this URL slug already exists. Try renaming slightly or contact support.",
        },
        409,
      );
    }
    return json(
      { ok: false, error: `venue_insert: ${venueError.message}`, code: venueError.code ?? null },
      400,
    );
  }
  if (!venue) {
    return json({ ok: false, error: "venue_insert: no row returned" }, 500);
  }

  // Intentionally no venue_members insert. The caller becomes the owner only
  // when admin-decide-verification approves their ownership claim — until then,
  // the venue is publicly listed but unowned. The async enrich dispatch stays
  // with the natural caller (business-create-unit); this seed is purely sync.
  return json(
    { ok: true, id: venue.id, slug: venue.slug, name: venue.name, status: venue.status },
    201,
  );
});

// Maps Google Place Details reviews (up to 5) into the google_reviews jsonb
// shape the consumer venue-detail modal renders: { author, rating, quote,
// date }. Returns null when Google returned no reviews so the column stays
// honestly empty rather than [].
function mapGoogleReviews(
  reviews: GoogleDetails["reviews"],
): { author: string; rating: number; quote: string; date: string }[] | null {
  if (!Array.isArray(reviews) || reviews.length === 0) return null;
  const mapped = reviews
    .map((r) => ({
      author: r.authorAttribution?.displayName ?? "Google reviewer",
      rating: typeof r.rating === "number" ? r.rating : 0,
      quote: (r.text?.text ?? r.originalText?.text ?? "").trim(),
      date: r.relativePublishTimeDescription ?? "",
    }))
    .filter((r) => r.quote.length > 0);
  return mapped.length > 0 ? mapped : null;
}

function isMissingCategoryLabelColumnError(err: { message?: string } | null): boolean {
  if (!err?.message) return false;
  return (
    err.message.includes("category_label") &&
    (err.message.includes("schema cache") || err.message.includes("column"))
  );
}

function isMissingYelpUrlColumnError(err: { message?: string } | null): boolean {
  if (!err?.message) return false;
  return (
    err.message.includes("yelp_url") &&
    (err.message.includes("schema cache") || err.message.includes("column"))
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Google Places
// ───────────────────────────────────────────────────────────────────────────

// Google Places (New) occasionally returns 5xx during regional hiccups.
// One retry with a short wait covers the typical transient case without
// adding meaningful latency on the happy path. The returned `error`
// shape is friendly (already classified) so the caller can surface it
// directly to the operator.
async function fetchGoogleDetails(
  placeId: string,
  apiKey: string,
): Promise<GoogleDetails | { error: string; transient: boolean }> {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=es-MX&regionCode=MX`;
  const doFetch = () =>
    fetch(url, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
      },
    });

  let r = await doFetch();
  if (r.status >= 500 && r.status < 600) {
    await new Promise((res) => setTimeout(res, 800));
    r = await doFetch();
  }

  if (!r.ok) {
    const text = await r.text();
    const transient = r.status >= 500 && r.status < 600;
    const friendly = transient
      ? "Google Places is temporarily unavailable. Try again in a few seconds."
      : r.status === 429
        ? "Google Places rate-limited the request. Try again in a moment."
        : r.status === 404
          ? "Google couldn't find that place. Try searching again."
          : `Google rejected the request (${r.status}). ${text.slice(0, 160)}`;
    return { error: friendly, transient };
  }
  return (await r.json()) as GoogleDetails;
}

async function fetchGooglePhotos(
  photos: NonNullable<GoogleDetails["photos"]>,
  max: number,
  apiKey: string,
): Promise<{ photoUri: string }[]> {
  if (!photos.length) return [];
  const top = photos.slice(0, max);
  const settled = await Promise.allSettled(
    top.map(async (p) => {
      if (!p.name) throw new Error("photo missing name");
      const r = await fetch(
        `https://places.googleapis.com/v1/${p.name}/media?maxHeightPx=1600&skipHttpRedirect=true`,
        { headers: { "X-Goog-Api-Key": apiKey } },
      );
      if (!r.ok) throw new Error(`photo HTTP ${r.status}`);
      const d = (await r.json()) as { photoUri?: string };
      if (!d.photoUri) throw new Error("photo missing uri");
      return { photoUri: d.photoUri };
    }),
  );
  return settled
    .filter((s): s is PromiseFulfilledResult<{ photoUri: string }> => s.status === "fulfilled")
    .map((s) => s.value);
}

// ───────────────────────────────────────────────────────────────────────────
// Google Time Zone API
// ───────────────────────────────────────────────────────────────────────────

// Returns an IANA tz id (e.g. "America/Monterrey") for the venue's lat/lng,
// or null on any failure. Uses the same Google key as Places — needs the
// "Time Zone API" enabled on the project (separate enable from Places).
// `timestamp` is required by Google but only matters for DST resolution; we
// pass "now" since we only consume timeZoneId.
async function fetchTimezone(
  lat: number | undefined,
  lng: number | undefined,
  apiKey: string,
): Promise<string | null> {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${ts}&key=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = (await r.json()) as { status?: string; timeZoneId?: string };
    if (d.status !== "OK") return null;
    return d.timeZoneId ?? null;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function findAddressComponent(
  components: GoogleDetails["addressComponents"],
  types: string[],
): string | null {
  if (!components) return null;
  for (const type of types) {
    const found = components.find((c) => c.types?.includes(type));
    if (found?.longText) return found.longText;
  }
  return null;
}

function priceLevelFromGoogle(p?: string): number | null {
  switch (p) {
    case "PRICE_LEVEL_FREE":
    case "PRICE_LEVEL_INEXPENSIVE":
      return 1;
    case "PRICE_LEVEL_MODERATE":
      return 2;
    case "PRICE_LEVEL_EXPENSIVE":
      return 3;
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return 4;
    default:
      return null;
  }
}

function weeklyHoursFromPeriods(periods: GooglePeriod[] | undefined): WeeklyHours | null {
  if (!periods || periods.length === 0) return null;
  const out: WeeklyHours = {};

  // 24/7 venues come back as a single period with `open` only, day=0, hour=0.
  // Mirror that as every day 00:00→23:59 so consumers don't special-case.
  if (
    periods.length === 1 &&
    periods[0].open &&
    !periods[0].close &&
    (periods[0].open.hour ?? 0) === 0 &&
    (periods[0].open.minute ?? 0) === 0
  ) {
    for (const day of DAY_KEYS) {
      out[day] = [{ open: "00:00", close: "23:59" }];
    }
    return out;
  }

  for (const p of periods) {
    const oDay = p.open?.day;
    if (typeof oDay !== "number" || oDay < 0 || oDay > 6) continue;
    const openStr = hhmm(p.open?.hour, p.open?.minute);
    if (!openStr) continue;

    // No close → open-ended; record start only with a placeholder close.
    if (!p.close) {
      pushRange(out, DAY_KEYS[oDay], openStr, "23:59");
      continue;
    }

    const cDay = p.close.day;
    const closeStr = hhmm(p.close.hour, p.close.minute);
    if (typeof cDay !== "number" || !closeStr) continue;

    // Same-day or overnight — both store as one range on the opening day.
    // For overnight, close ≤ open is the next-day-close signal the UI and
    // any time-window math read from. Splitting at midnight is what used
    // to make a 6pm–2am venue render as two confusing rows; one range
    // tells the truth in one place.
    pushRange(out, DAY_KEYS[oDay], openStr, closeStr);
  }

  return Object.keys(out).length > 0 ? out : null;
}

function hhmm(hour: number | undefined, minute: number | undefined): string | null {
  if (typeof hour !== "number" || hour < 0 || hour > 23) return null;
  const m = typeof minute === "number" && minute >= 0 && minute <= 59 ? minute : 0;
  return `${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function pushRange(hours: WeeklyHours, day: DayKey, open: string, close: string): void {
  (hours[day] ??= []).push({ open, close });
}

function closesAtFromHours(weekdayDescriptions: string[]): string | null {
  // Best-effort: "Friday: 6:00 PM – 2:00 AM" → "02:00"
  for (const line of weekdayDescriptions) {
    const m = line.match(/[-–—]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const mm = m[2];
      const ampm = m[3]?.toUpperCase();
      if (ampm === "PM" && h < 12) h += 12;
      if (ampm === "AM" && h === 12) h = 0;
      return `${String(h).padStart(2, "0")}:${mm}`;
    }
  }
  return null;
}
