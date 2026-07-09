// Sourcing policy enforcement — the BACKEND owner of the sourcing gate.
//
// public.app_settings.sourcing_config (id=1) decides, per sourcing CHANNEL,
// which place FAMILIES may enter Mesita and the Google quality bar (min rating +
// min review count). The admin console authors it; this module is where an
// add-path actually ENFORCES it — a client can't be trusted to self-gate.
//
// The family → Google-primaryType map below is the enforcement contract. It
// MUST stay in lock-step with the admin catalog
// (mesita-web-admin/src/app/(app)/sourcing-config/catalog.ts, FAMILIES[].googleTypes)
// and the migration default (20260708120000_sourcing_config.sql) — the family
// keys are the shared contract. A Google primaryType in NO family is ineligible
// for every channel: that's how hotels, schools, hospitals, shops, gas stations
// and transit are kept out without an explicit blocklist.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type FamilyKey =
  | "restaurants"
  | "bars_nightlife"
  | "cafes_bakeries"
  | "wellness_spa"
  | "experiences"
  | "culture_arts";

export type ChannelKey =
  | "admin_search"
  | "admin_add"
  | "business_search"
  | "business_add"
  | "consumer_search"
  | "consumer_add"
  | "memo_search";

export type ChannelPolicy = {
  enabled: boolean;
  families: FamilyKey[];
  minRating: number;
  minReviews: number;
};

// Machine expansion of each family — the Google `primaryType` values a place
// must match to count as that family. Mirror of the admin catalog's
// FAMILIES[].googleTypes; keep both in sync when Google adds Table A types.
const FAMILY_GOOGLE_TYPES: Record<FamilyKey, readonly string[]> = {
  restaurants: [
    "restaurant", "fine_dining_restaurant", "steak_house", "seafood_restaurant",
    "sushi_restaurant", "japanese_restaurant", "mexican_restaurant", "italian_restaurant",
    "pizza_restaurant", "mediterranean_restaurant", "american_restaurant", "asian_restaurant",
    "chinese_restaurant", "thai_restaurant", "indian_restaurant", "french_restaurant",
    "spanish_restaurant", "korean_restaurant", "vietnamese_restaurant", "middle_eastern_restaurant",
    "vegan_restaurant", "vegetarian_restaurant", "barbecue_restaurant", "hamburger_restaurant",
    "taco_restaurant", "ramen_restaurant", "tapas_restaurant", "brunch_restaurant",
    "breakfast_restaurant", "bistro", "diner", "gastropub", "buffet_restaurant", "food_court",
  ],
  bars_nightlife: [
    "bar", "cocktail_bar", "wine_bar", "sports_bar", "lounge_bar", "pub", "irish_pub",
    "gastropub", "beer_garden", "brewery", "brewpub", "hookah_bar", "night_club",
    "dance_hall", "live_music_venue", "karaoke", "comedy_club", "casino",
  ],
  cafes_bakeries: [
    "cafe", "coffee_shop", "coffee_roastery", "coffee_stand", "cat_cafe", "dog_cafe",
    "tea_house", "bakery", "cake_shop", "pastry_shop", "bagel_shop", "donut_shop",
    "dessert_shop", "dessert_restaurant", "ice_cream_shop", "acai_shop", "juice_shop",
    "chocolate_shop", "confectionery",
  ],
  wellness_spa: [
    "spa", "massage_spa", "massage", "sauna", "wellness_center", "yoga_studio", "skin_care_clinic",
  ],
  experiences: [
    "tourist_attraction", "amusement_park", "amusement_center", "water_park", "aquarium",
    "zoo", "bowling_alley", "video_arcade", "go_karting_venue", "paintball_center",
    "miniature_golf_course", "ice_skating_rink", "escape_room", "winery", "vineyard",
    "botanical_garden", "planetarium", "observation_deck", "marina", "event_venue",
    "banquet_hall", "wedding_venue",
  ],
  culture_arts: [
    "museum", "art_museum", "history_museum", "art_gallery", "cultural_center",
    "cultural_landmark", "historical_place", "monument", "performing_arts_theater",
    "concert_hall", "opera_house", "philharmonic_hall", "movie_theater",
  ],
};

const ALL_FAMILY_KEYS = Object.keys(FAMILY_GOOGLE_TYPES) as FamilyKey[];

// gastropub is listed under both restaurants and bars_nightlife in the catalog;
// first-match wins, which is fine — either family being enabled admits it.
const GOOGLE_TYPE_TO_FAMILY: Record<string, FamilyKey> = (() => {
  const m: Record<string, FamilyKey> = {};
  for (const fam of ALL_FAMILY_KEYS) {
    for (const t of FAMILY_GOOGLE_TYPES[fam]) {
      if (!(t in m)) m[t] = fam;
    }
  }
  return m;
})();

export function familyForGoogleType(primaryType: string | null | undefined): FamilyKey | null {
  if (!primaryType) return null;
  return GOOGLE_TYPE_TO_FAMILY[primaryType] ?? null;
}

// The launch policy — must match 20260708120000_sourcing_config.sql and the
// admin catalog's DEFAULT_CONFIG. Used as the fallback when the app_settings
// read fails or a channel key is absent, so a transient error still enforces
// the intended floors rather than failing open to "allow anything".
const DEFAULT_POLICY: Record<ChannelKey, ChannelPolicy> = {
  admin_search: { enabled: true, families: [...ALL_FAMILY_KEYS], minRating: 0, minReviews: 0 },
  admin_add: { enabled: true, families: [...ALL_FAMILY_KEYS], minRating: 0, minReviews: 0 },
  business_search: { enabled: true, families: [...ALL_FAMILY_KEYS], minRating: 0, minReviews: 0 },
  business_add: { enabled: true, families: [...ALL_FAMILY_KEYS], minRating: 0, minReviews: 0 },
  consumer_search: { enabled: true, families: [...ALL_FAMILY_KEYS], minRating: 3.5, minReviews: 50 },
  consumer_add: { enabled: true, families: [...ALL_FAMILY_KEYS], minRating: 3.5, minReviews: 100 },
  memo_search: { enabled: true, families: [...ALL_FAMILY_KEYS], minRating: 4.0, minReviews: 50 },
};

// Coerce the stored jsonb for one channel into a well-typed ChannelPolicy,
// filling missing/invalid fields from the channel default and dropping unknown
// families. Mirror of the admin catalog's coerceConfig (per-channel slice).
export function coerceChannelPolicy(raw: unknown, channel: ChannelKey): ChannelPolicy {
  const d = DEFAULT_POLICY[channel];
  if (!raw || typeof raw !== "object") return { ...d, families: [...d.families] };
  const o = raw as Record<string, unknown>;
  const families = Array.isArray(o.families)
    ? (o.families.filter(
        (f): f is FamilyKey => typeof f === "string" && (ALL_FAMILY_KEYS as string[]).includes(f),
      ) as FamilyKey[])
    : [...d.families];
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled,
    families,
    minRating: typeof o.minRating === "number" ? o.minRating : d.minRating,
    minReviews: typeof o.minReviews === "number" ? o.minReviews : d.minReviews,
  };
}

export type PlaceSignals = {
  primaryType: string | null;
  rating: number | null;
  reviewCount: number | null;
};

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; code: string; reason: string };

// Evaluate one place against one channel policy. Order: disabled → family →
// rating → reviews, returning the first failing gate with consumer-friendly
// copy. minRating/minReviews of 0 mean "no floor". A null rating/reviewCount
// fails any non-zero floor (an unrated place hasn't cleared the bar).
// One broad Table A primary type per family — used to build the Google
// Autocomplete `includedPrimaryTypes` list (API cap: 5). Picking the
// broadest type per enabled family keeps the picker aligned with the
// family allowlist without listing every cuisine variant.
const FAMILY_AUTOCOMPLETE_TYPE: Record<FamilyKey, string> = {
  restaurants: "restaurant",
  bars_nightlife: "bar",
  cafes_bakeries: "cafe",
  wellness_spa: "spa",
  experiences: "tourist_attraction",
  culture_arts: "museum",
};

// Up to 5 Google primary types for Autocomplete, derived from the channel's
// enabled families. Empty when every family is off — callers should skip the
// Google leg rather than query with no type filter.
export function autocompleteTypesForPolicy(policy: ChannelPolicy): string[] {
  return policy.families
    .slice(0, 5)
    .map((f) => FAMILY_AUTOCOMPLETE_TYPE[f])
    .filter(Boolean);
}

export type SourcingConfigRow = Partial<Record<ChannelKey, unknown>>;

// Read one channel slice from app_settings.sourcing_config, coerced with the
// launch-policy fallback. Shared by add-paths and search-paths.
export async function readChannelPolicy(
  admin: SupabaseClient,
  channel: ChannelKey,
): Promise<ChannelPolicy> {
  try {
    const { data } = await admin
      .from("app_settings")
      .select("sourcing_config")
      .eq("id", 1)
      .maybeSingle();
    const raw = (data?.sourcing_config as SourcingConfigRow | null)?.[channel];
    return coerceChannelPolicy(raw, channel);
  } catch {
    return coerceChannelPolicy(null, channel);
  }
}

export function evaluatePlaceForChannel(
  policy: ChannelPolicy,
  signals: PlaceSignals,
): EligibilityResult {
  if (!policy.enabled) {
    return { eligible: false, code: "channel_disabled", reason: "Adding new places is currently turned off." };
  }

  const family = familyForGoogleType(signals.primaryType);
  if (family === null || !policy.families.includes(family)) {
    return {
      eligible: false,
      code: "family_not_eligible",
      reason: "This kind of place can't be added to Mesita — we only list restaurants, bars, cafés, wellness, experiences and culture spots.",
    };
  }

  if (policy.minRating > 0 && (signals.rating === null || signals.rating < policy.minRating)) {
    return {
      eligible: false,
      code: "below_min_rating",
      reason: `This place doesn't meet Mesita's minimum Google rating (${policy.minRating}★).`,
    };
  }

  if (policy.minReviews > 0 && (signals.reviewCount === null || signals.reviewCount < policy.minReviews)) {
    return {
      eligible: false,
      code: "below_min_reviews",
      reason: `This place doesn't have enough Google reviews yet (min ${policy.minReviews}).`,
    };
  }

  return { eligible: true };
}
