// Shared Enricher place field limits — mirrored in business-web-update-project and
// the business Place editor. Surfaced read-only in admin-web-get-atlas-fields.

export const ENRICH_FIELD_LIMITS = {
  placeName: { max: 80, note: "Business Place editor" },
  description: { max: 2000, note: "About / description (business-web-update-project)" },
  tagsPerPlace: { max: 20, note: "Up to 20 tags per place (places.tags)" },
  tagCatalogSize: { max: 100, note: "Controlled tags in place_tags" },
  tagSlugLength: { max: 40, note: "Per-tag slug length cap" },
  photos: { max: 10, note: "places.photos array (hero + gallery)" },
  // Hard Apify scrape ceiling (EF wall-clock + cost). Live gather count is
  // app_settings.atlas_gather_reviews (0–100) on Enricher Config; this is the
  // profile-spec max the pipeline may never exceed.
  googleReviews: {
    max: 100,
    note: "places.google_reviews — Apify scrape cap (Places API ~5; Mesita EF/cost safety bound)",
  },
} as const;
