// Shared Atlas venue field limits — mirrored in business-update-unit and
// the business Place editor. Surfaced read-only in admin-get-atlas-fields.

export const ATLAS_FIELD_LIMITS = {
  venueName: { max: 120, note: "Business Place editor" },
  description: { max: 2000, note: "About / description (business-update-unit)" },
  tagsPerVenue: { max: 12, note: "Max tags on venues.tags" },
  tagSlugLength: { max: 40, note: "Per-tag slug length cap" },
  photos: { max: 30, note: "venues.photos array" },
  prLinks: { max: 10, note: "WhatsApp / Instagram PR URL arrays" },
} as const;
