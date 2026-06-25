// Candidate-pool query shared by every recommender pipeline.
//
// Recommender EFs (consumer-recommend-deck, consumer-recommend-catalog, and
// the new recommender-* artificial callers) all start the same way: pull a
// bounded set of active venues — by bounding-box if the caller has a
// location, otherwise newest-first — then hand the rows to the ranker.
// Keeping the SELECT in one place means new columns flow into every
// recommender without per-EF edits.

import type { createClient } from "jsr:@supabase/supabase-js@2";
import { VENUE_PUBLIC_COLUMNS } from "./venue-columns.ts";
import { haversineKm, radiusBoundingBox } from "./geo.ts";

// Same projection as VENUE_PUBLIC_COLUMNS but with the two ranker-internal
// columns appended. Both columns are stripped by the ranker before the row
// crosses back over the wire to the client.
const RECOMMENDER_VENUE_COLUMNS =
  VENUE_PUBLIC_COLUMNS + ", embedding, embedding_source_hash";

// Shape of a candidate venue row as projected by RECOMMENDER_VENUE_COLUMNS.
// Both rankers (recommender-rank-deck, recommender-rank-catalog) cast the
// candidate pool to this type. The trailing `embedding` /
// `embedding_source_hash` are ranker-internal and get stripped by
// stripInternal before the row crosses back over the wire to the client.
export type VenueRow = {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  vibe: string | null;
  price_level: number | null;
  listing_type: "partner" | "web";
  status: string;
  fiscal_type: string | null;
  plan: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  closes_at: string | null;
  phone: string | null;
  pitch: string | null;
  story: string | null;
  photos: string[] | null;
  [key: string]: unknown;
  embedding: unknown | null;
  embedding_source_hash: string | null;
};

// Minimal consumer-context the rankers thread into intent composition /
// category proposal. Anonymous requests pass null; tier drives the Premium
// overlay and aspirational curation.
export type ConsumerProfile = {
  full_name: string | null;
  country: string | null;
  birthday: string | null;
  sex: string | null;
  tier?: string | null;
};

export function clampPositive(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

// Drops the two ranker-internal columns so the row is safe to return to the
// client. The leading-underscore rest-omit destructuring discards them.
export function stripInternal(
  v: VenueRow,
): Omit<VenueRow, "embedding" | "embedding_source_hash"> {
  const { embedding: _e, embedding_source_hash: _h, ...rest } = v;
  return rest;
}

type CandidatePoolOptions = {
  lat: number | null;
  lng: number | null;
  radiusKm: number;
  poolSize: number;
};

type CandidatePoolResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; error: string };

// Returns the rows trimmed to radius (when location is supplied) and capped
// at poolSize. Callers cast the result to their local VenueRow type so they
// can keep stricter typing — the rows always satisfy EmbeddableVenue at
// minimum because RECOMMENDER_VENUE_COLUMNS includes everything embeddings.ts
// needs.
export async function fetchCandidatePool<T extends { lat: number | null; lng: number | null }>(
  admin: ReturnType<typeof createClient>,
  { lat, lng, radiusKm, poolSize }: CandidatePoolOptions,
): Promise<CandidatePoolResult<T>> {
  if (lat != null && lng != null) {
    const { latDelta, lngDelta } = radiusBoundingBox(lat, radiusKm);
    const { data, error } = await admin
      .from("venues")
      .select(RECOMMENDER_VENUE_COLUMNS)
      .eq("status", "active")
      .gte("lat", lat - latDelta)
      .lte("lat", lat + latDelta)
      .gte("lng", lng - lngDelta)
      .lte("lng", lng + lngDelta)
      .limit(poolSize);
    if (error) return { ok: false, error: error.message };
    // Exact haversine trim — bounding box is coarse, especially at higher
    // latitudes where the lng span overshoots.
    const trimmed = ((data ?? []) as T[]).filter(
      (v) => haversineKm(lat, lng, v.lat, v.lng) <= radiusKm,
    );
    return { ok: true, rows: trimmed };
  }

  const { data, error } = await admin
    .from("venues")
    .select(RECOMMENDER_VENUE_COLUMNS)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(poolSize);
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: (data ?? []) as T[] };
}
