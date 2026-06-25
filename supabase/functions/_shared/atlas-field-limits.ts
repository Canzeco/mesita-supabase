// Shared Atlas venue field limits — mirrored in business-update-unit and
// the business Place editor. Surfaced read-only in admin-get-atlas-fields.

export const ATLAS_FIELD_LIMITS = {
  venueName: { max: 80, note: "Business Place editor" },
  description: { max: 2000, note: "About / description (business-update-unit)" },
  tagsPerVenue: { max: 20, note: "Up to 20 tags per venue (venues.tags)" },
  tagCatalogSize: { max: 100, note: "Controlled tags in venue_tags" },
  tagSlugLength: { max: 40, note: "Per-tag slug length cap" },
  photos: { max: 10, note: "venues.photos array (hero + gallery)" },
  prWhatsappNumbers: {
    max: 3,
    note: "venues.whatsapp_pr_urls — concierge PR WhatsApp (wa.me URLs)",
  },
  prInstagramAccounts: {
    max: 3,
    note: "venues.instagram_pr_urls — PR / events Instagram accounts",
  },
} as const;
