// Atlas source — Apify Google Maps: ALL reviews (Places caps at ~5) + venue
// PHOTOS in one run. Spine-tier. Reviews capped at 100 for the EF wall-clock
// (a safety bound, not a product cap); images capped at the Google gather cap.

import { APIFY_ACTORS, runApifyActor } from "./apify.ts";
import { numOf } from "./parse-utils.ts";

export type GoogleMapsResult = {
  reviews: Record<string, unknown>[];
  reviewCount: number | null;
  googleReviewsText: string;
  googleImages: string[];
  diag: Record<string, unknown>;
};

export async function gatherGoogleMaps(opts: {
  apifyKey: string;
  placeId: string;
  gatherGoogleImages: number;
}): Promise<GoogleMapsResult> {
  const { apifyKey, placeId, gatherGoogleImages } = opts;
  const items = await runApifyActor<Record<string, unknown>>(
    APIFY_ACTORS.googleMaps,
    {
      placeIds: [placeId],
      maxReviews: 100,
      maxImages: Math.max(0, gatherGoogleImages),
      language: "es",
      reviewsSort: "newest",
      reviewsPersonalData: true,
    },
    apifyKey,
    60000,
  );
  const p = items?.[0] as Record<string, unknown> | undefined;
  const raw = Array.isArray(p?.reviews) ? (p!.reviews as Record<string, unknown>[]) : [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const reviews = raw
    .slice(0, 100)
    .map((r) => ({
      author: str(r.name) ?? str(r.reviewerName),
      rating: numOf(r.stars) ?? numOf(r.rating) ?? numOf(r.starRating),
      text: str(r.text) ?? str(r.textTranslated) ?? str(r.reviewText),
      published: str(r.publishedAtDate) ?? str(r.publishAt) ?? str(r.publishedAt),
    }))
    .filter((r) => r.text || r.rating != null);
  const reviewCount = numOf(p?.reviewsCount);
  const withText = reviews.filter((r) => r.text);
  const googleReviewsText = withText
    .slice(0, 12)
    .map((r) => `(${r.rating ?? "?"}★) ${r.text}`)
    .join("\n")
    .slice(0, 3000);
  // Google photos straight from the same run (durable lh3 URLs).
  const imgs = Array.isArray(p?.imageUrls) ? (p!.imageUrls as unknown[]) : [];
  const googleImages = imgs
    .filter((u): u is string => typeof u === "string" && u.startsWith("http"))
    .slice(0, gatherGoogleImages);
  return {
    reviews,
    reviewCount,
    googleReviewsText,
    googleImages,
    diag: {
      ok: reviews.length > 0,
      count: reviews.length,
      with_text: withText.length,
      images: googleImages.length,
      sample_keys: raw[0] ? Object.keys(raw[0]).slice(0, 25) : [],
    },
  };
}
