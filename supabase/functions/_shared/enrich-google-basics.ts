// Shared — Google Places "basics" fetch.
//
// Extracted from the old atlas-seed-place so the create pipeline
// can build the identity spine in-memory without a
// DB seed. Fetches Google Places BASICS ONLY (name, address, geo, category,
// phone, hours, first photos, Google ratings/reviews, identity links) and
// returns them as a flat `places`-shaped object. NO Firecrawl/Perplexity/
// OpenAI/CSE/Instagram — that heavy work is the enrichment pipeline's job.
//
// Returns { ok:true, basics } or { ok:false, code, error, status } so callers
// can pass Google outages / spine-incomplete rejections straight through with
// the same status codes the old seed used (409/422/502/503).

import { classifyLinks } from "./channels.ts";
import { slugify } from "./place-slug.ts";
import { humanizeCategorySlug } from "./parse-utils.ts";
import { ENRICH_FIELD_LIMITS } from "./enrich-field-limits.ts";

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

// Candidate photo URLs collected from Google before any quality pass (Places
// only — no CSE/Firecrawl here). The enricher re-gathers + vision-ranks later.
const MAX_PHOTOS = 20;
const MAX_PHOTOS_TO_KEEP = 10;

type GooglePeriod = {
  open?: { day?: number; hour?: number; minute?: number };
  close?: { day?: number; hour?: number; minute?: number };
};

type DayKey =
  | "sunday" | "monday" | "tuesday" | "wednesday"
  | "thursday" | "friday" | "saturday";
const DAY_KEYS: DayKey[] = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];
type WeeklyHours = Partial<Record<DayKey, { open: string; close: string }[]>>;

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
  reviews?: {
    rating?: number;
    text?: { text?: string };
    originalText?: { text?: string };
    relativePublishTimeDescription?: string;
    authorAttribution?: { displayName?: string };
  }[];
  photos?: { name?: string; widthPx?: number; heightPx?: number }[];
};

// Flat, `places`-shaped identity spine. Unit-level fields (slug, status,
// listing_type, content_status, plan…) are intentionally absent — the save step
// generates the unique slug and applies entity defaults.
export type GoogleBasics = {
  google_place_id: string;
  name: string;
  category: string | null;
  category_label: string | null;
  price_level: number | null;
  lat: number;
  lng: number;
  address: string;
  city: string | null;
  country: string | null;
  timezone: string | null;
  closes_at: string | null;
  hours: WeeklyHours | null;
  phone: string | null;
  pitch: string | null;
  story: string | null;
  photos: string[];
  website_url: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  x_url: string | null;
  threads_url: string | null;
  reddit_url: string | null;
  whatsapp_url: string | null;
  opentable_url: string | null;
  resy_url: string | null;
  uber_eats_url: string | null;
  didi_food_url: string | null;
  tripadvisor_url: string | null;
  yelp_url: string | null;
  google_maps_url: string | null;
  email: string | null;
  google_stars_overall: number | null;
  google_review_count: number | null;
  google_reviews: { author: string; rating: number; quote: string; date: string }[] | null;
  editorial_summary: string | null;
};

export type GoogleBasicsResult =
  // `primaryType` is the raw Google Places (New) primary type (e.g.
  // "cocktail_bar"). Returned alongside `basics` — NOT inside it — because it's
  // a sourcing-gate signal (see _shared/sourcing.ts), not a persisted column.
  | { ok: true; basics: GoogleBasics; primaryType: string | null }
  | { ok: false; code: string; error: string; status: number };

// Fetch + assemble the Google identity spine for a placeId. Mirrors the old
// atlas-seed-place's pre-insert logic exactly (including the spine-incomplete
// rejection), minus any DB work.
export async function fetchGoogleBasics(
  placeId: string,
  googleKey: string,
): Promise<GoogleBasicsResult> {
  const details = await fetchGoogleDetails(placeId, googleKey);
  if ("error" in details) {
    return {
      ok: false,
      code: details.transient ? "google_unavailable" : "google_error",
      error: details.error,
      status: details.transient ? 503 : 502,
    };
  }

  // Google Business is the spine: no name / coords / address ⇒ not a real
  // listing. Reject rather than emit a half-null profile.
  const name = details.displayName?.text ?? "";
  if (!name) {
    return { ok: false, code: "google_spine_incomplete", status: 422, error: "Place has no display name on Google — can't list it." };
  }
  if (details.location?.latitude == null || details.location?.longitude == null) {
    return { ok: false, code: "google_spine_incomplete", status: 422, error: "Place has no coordinates on Google — can't list it." };
  }
  const address = details.formattedAddress ?? null;
  if (!address) {
    return { ok: false, code: "google_spine_incomplete", status: 422, error: "Place has no address on Google — can't list it." };
  }

  const city = findAddressComponent(details.addressComponents, ["locality", "administrative_area_level_2"]);
  const country = findAddressComponent(details.addressComponents, ["country"]);

  const [photosResult, timezoneResult] = await Promise.allSettled([
    fetchGooglePhotos(details.photos ?? [], MAX_PHOTOS, googleKey),
    fetchTimezone(details.location?.latitude, details.location?.longitude, googleKey),
  ]);
  const placesPhotos = photosResult.status === "fulfilled" ? photosResult.value : [];
  const timezone = timezoneResult.status === "fulfilled" ? timezoneResult.value : null;
  const photos = placesPhotos.map((p) => p.photoUri).filter(Boolean).slice(0, MAX_PHOTOS_TO_KEEP);

  // Google-derived identity links only (website + maps). No email here — the
  // enricher fills socials/email via its link-discovery step.
  const channels = classifyLinks([details.websiteUri, details.googleMapsUri]);

  // Cheap Google placeholder category; the enricher re-infers the real one.
  const categorySlug = slugify(details.primaryTypeDisplayName?.text ?? details.primaryType ?? "") || null;
  const categoryLabel = categorySlug ? humanizeCategorySlug(categorySlug) : null;

  const hours = weeklyHoursFromPeriods(details.regularOpeningHours?.periods);
  const closesAt = closesAtFromHours(details.regularOpeningHours?.weekdayDescriptions ?? []);

  return {
    ok: true,
    primaryType: details.primaryType ?? null,
    basics: {
      google_place_id: details.id ?? placeId,
      name: name.slice(0, ENRICH_FIELD_LIMITS.placeName.max),
      category: categorySlug,
      category_label: categoryLabel ?? humanizeCategorySlug(categorySlug ?? ""),
      price_level: priceLevelFromGoogle(details.priceLevel),
      lat: details.location.latitude,
      lng: details.location.longitude,
      address,
      city,
      country,
      timezone,
      closes_at: closesAt,
      hours,
      phone: internationalPhone(details, country),
      pitch: details.editorialSummary?.text ?? null,
      story: details.generativeSummary?.overview?.text ?? null,
      photos,
      website_url: channels.website_url,
      instagram_url: channels.instagram_url,
      facebook_url: channels.facebook_url,
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
      email: null,
      google_stars_overall: details.rating ?? null,
      google_review_count: details.userRatingCount ?? null,
      google_reviews: mapGoogleReviews(details.reviews),
      editorial_summary: details.editorialSummary?.text ?? null,
    },
  };
}

// ── Google Places (New) ──────────────────────────────────────────────────────
async function fetchGoogleDetails(
  placeId: string,
  apiKey: string,
): Promise<GoogleDetails | { error: string; transient: boolean }> {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=es-MX&regionCode=MX`;
  const doFetch = () =>
    fetch(url, { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": GOOGLE_FIELD_MASK } });

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
  const settled = await Promise.allSettled(
    photos.slice(0, max).map(async (p) => {
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

async function fetchTimezone(
  lat: number | undefined,
  lng: number | undefined,
  apiKey: string,
): Promise<string | null> {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${ts}&key=${apiKey}`,
    );
    if (!r.ok) return null;
    const d = (await r.json()) as { status?: string; timeZoneId?: string };
    return d.status === "OK" ? (d.timeZoneId ?? null) : null;
  } catch {
    return null;
  }
}

// ── helpers (ported verbatim from atlas-seed-place) ─────────────────────────
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

// Phone must ALWAYS carry the country code. Prefer Google's international
// format outright; a bare national number is only salvaged when we know the
// place's country calling code (Mesita is Mexico-only today) — otherwise we
// store no phone rather than one the Reservationist can't dial cross-border.
const COUNTRY_CALLING_CODES: Record<string, string> = {
  "México": "+52",
  "Mexico": "+52",
};

function internationalPhone(
  details: Pick<GoogleDetails, "internationalPhoneNumber" | "nationalPhoneNumber">,
  country: string | null,
): string | null {
  const intl = details.internationalPhoneNumber?.trim();
  if (intl) return intl.startsWith("+") ? intl : `+${intl}`;
  const national = details.nationalPhoneNumber?.trim();
  if (!national) return null;
  if (national.startsWith("+")) return national;
  const code = country ? COUNTRY_CALLING_CODES[country] : undefined;
  return code ? `${code} ${national}` : null;
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
  if (
    periods.length === 1 && periods[0].open && !periods[0].close &&
    (periods[0].open.hour ?? 0) === 0 && (periods[0].open.minute ?? 0) === 0
  ) {
    for (const day of DAY_KEYS) out[day] = [{ open: "00:00", close: "23:59" }];
    return out;
  }
  for (const p of periods) {
    const oDay = p.open?.day;
    if (typeof oDay !== "number" || oDay < 0 || oDay > 6) continue;
    const openStr = hhmm(p.open?.hour, p.open?.minute);
    if (!openStr) continue;
    if (!p.close) {
      pushRange(out, DAY_KEYS[oDay], openStr, "23:59");
      continue;
    }
    const cDay = p.close.day;
    const closeStr = hhmm(p.close.hour, p.close.minute);
    if (typeof cDay !== "number" || !closeStr) continue;
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
  for (const line of weekdayDescriptions) {
    const m = line.match(/[-–—]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const ampm = m[3]?.toUpperCase();
      if (ampm === "PM" && h < 12) h += 12;
      if (ampm === "AM" && h === 12) h = 0;
      return `${String(h).padStart(2, "0")}:${m[2]}`;
    }
  }
  return null;
}
