// Single source of truth for the columns we SELECT off public.places.
//
// Before this file existed, every EF that read places maintained its own
// hand-typed PLACE_COLUMNS string and they drifted: consumer EFs were missing
// the columns added by the Place redesign (timezone, hours, description,
// menu_pdf_url, tags, the signal
// fields, etc.), so consumers literally couldn't see what businesses had just
// edited. Importing from here keeps every read in lock-step.
//
// If you add a column to places, update this file once and every reader
// gets it.

const COLUMNS: readonly string[] = [
  "id",
  "slug",
  "name",
  "category",
  // Human-friendly category copy (emoji + natural-language label),
  // derived from category via place_categories.
  "category_label",
  "vibe",
  "price_level",
  // ISO 4217 code (default MXN). Every monetary amount on a place —
  // price ranges shown on the consumer detail page, reward caps,
  // future cover charges — is denominated in this currency so the
  // client can render the right prefix ("MX$", "$", "€") without
  // hard-coding it.
  "currency",
  "listing_type",
  "status",
  "fiscal_type",
  "plan",
  "lat",
  "lng",
  "address",
  "timezone",
  "closes_at",
  "hours",
  "phone",
  // Legacy text fields. Description superseded them on the redesigned
  // Place page, but other callers and the old consumer Info view still read
  // pitch / story so we keep them in the projection.
  "pitch",
  "story",
  "description",
  // Four per-tier promo rates (free / premium). Welcome variants fire on a
  // guest's first visit at the place; the unprefixed variants apply on every
  // visit afterwards. Legal values: 10, 20, 50, 70 (nullable).
  "welcome_free_rate",
  "welcome_premium_rate",
  "free_rate",
  "premium_rate",
  // Place-level monthly promo spend ceiling (migration 0038), in the place's
  // currency. One of 200, 500, 1000, 2000 or null (no cap).
  "monthly_promo_cap",
  "photos",
  "menu_pdf_url",
  // Optional display name for menu_pdf_url, e.g. "Dinner menu" /
  // "Wine list". Null = consumer falls back to "Full menu" copy.
  "menu_pdf_name",
  "tags",
  // Channel URLs — primary, secondary, and PR. The Place page hides
  // secondary + PR for now but the values still round-trip through every
  // read and write, so they stay in the projection.
  "website_url",
  "instagram_url",
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
  "google_business_url",
  // Reservationist booking target + multi-contact list (MESITA-377).
  "reservation_endpoint",
  "reservation_contacts",
  // Read-only signal columns — populated by enrichment, never by the
  // business. Shown on the Place page's Signals section and on consumer
  // surfaces that compare places.
  "google_stars_overall",
  "google_review_count",
  "google_visitor_count",
  "mesita_stars_overall",
  "mesita_stars_food",
  "mesita_stars_service",
  "mesita_stars_ambience",
  "mesita_stars_value",
  "mesita_review_count",
  "mesita_visitor_count",
  "instagram_followers_count",
  "facebook_rating",
  "facebook_followers",
  // Complete-place profile (migration 0039). Scalars + JSONB filled by the
  // one-run enricher; all nullable.
  "editorial_summary",
  "zone",
  "city",
  "established_year",
  "executive_chef",
  "reward_cap_cents",
  "requires_story",
  "details",
  // Generic product payload. Menus live under products.menu.
  "products",
  "google_reviews",
  "menus",
  "popular_times",
  "enriched_at",
  // Enrichment lifecycle (projects.content_status: queued | generating |
  // ready | failed). Public-safe — lets consumer surfaces show an
  // "Enriching…" state on a freshly-added place instead of a misleading
  // "Updated just now" while the Enricher is still building the profile.
  "content_status",
  // Promos page section toggles. Boolean, business-controlled, persisted
  // so the on/off state survives page reloads.
  "segmentation_basic_enabled",
  "segmentation_advanced_enabled",
  "email",
  "created_at",
];

// Consumer reads — used by every public/consumer-facing EF. No `updated_at`
// because consumers don't need to see when the business last touched a row.
export const PLACE_PUBLIC_COLUMNS = COLUMNS.join(", ");

// Business reads — includes `updated_at` so the business UI can show
// "saved · 2 min ago" style affordances.
export const PLACE_BUSINESS_COLUMNS = [...COLUMNS, "updated_at"].join(", ");
