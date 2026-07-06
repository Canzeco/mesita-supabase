// Supabase Edge Function — supabase-edgefunc-discover-places (internal caller)
//
// Part of the Enricher namespace (place intelligence + encyclopaedia).
// Runs many Google Places Text Search queries in one batch and returns
// the union of Place IDs across all of them. Paginates each query up to
// the API max (3 pages × 20 = 60 results) and runs queries with bounded
// concurrency so a 50-query batch completes well inside the EF timeout.
//
// Quality filters (optional): minRating and minUserRatingCount let the
// operator drop low-signal places (a place with 800 reviews at 4.6 is
// almost always a real, good venue; one with 3 reviews usually isn't).
// Both are applied EF-side after the Google fetch — Google's Text Search
// has no server-side review-count filter, and filtering both here (rather
// than passing minRating natively) keeps a single code path AND lets us
// report per-query rawCount (fetched before filtering) so the UI can say
// "12 found · 4 shown" instead of a bare "4" that reads like the search
// found nothing. rating + userRatingCount stay in the Text Search Pro
// SKU, so surfacing them does not change the per-call price.
//
// Returned places are enriched with Mesita-side existence + timestamps so
// the natural caller can render "already on Mesita" badges without a
// second round-trip.
//
// Auth: internal caller — verify_jwt = true, so the gateway verifies the
// service_role JWT signature; requireInternalCaller then checks role=service_role.
//
// Deploy: supabase functions deploy supabase-edgefunc-discover-places

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import {
  GOOGLE_PLACES_TEXT_SEARCH_URL,
  googleErrorFromResponse,
  readGooglePlacesKey,
} from "../_shared/google-places.ts";

const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const MAX_RESULTS_PER_QUERY = PAGE_SIZE * MAX_PAGES; // 60

// Batch cap. With concurrency 10 and ~3 pages × ~500ms per query, 200
// queries land in roughly 30 seconds — comfortably inside the EF timeout
// while still meaningful for an operator pasting a large list of
// "cuisine × city" combinations.
const MAX_QUERIES_PER_BATCH = 200;
const CONCURRENCY = 10;

type RequestBody = {
  queries?: string[];
  regionCode?: string;
  maxResultsPerQuery?: number;
  // Quality filters. minRating is 0–5 (Google ratings are 1–5); 0 = off.
  // minUserRatingCount is a review-count floor; 0 = off. A place must
  // clear BOTH to survive. Places Google returns without a rating or
  // review count are treated as "unknown" and dropped only when the
  // corresponding filter is active (see passesQualityFilter).
  minRating?: number;
  minUserRatingCount?: number;
};

type PlaceLite = {
  id: string;
  displayName: string;
  formattedAddress: string;
  lat: number | null;
  lng: number | null;
  // Google quality signals from the Text Search Pro SKU. null when Google
  // returns the place without the field (rare, but e.g. brand-new listings
  // have no rating yet).
  rating: number | null;
  userRatingCount: number | null;
  // Mesita-side enrichment, populated after the Google round-trip by
  // looking each Place ID up against public.places.google_place_id.
  // Defaults to (false, null, null); the top-level mesitaLookupError
  // signals when the lookup couldn't run.
  existsInMesita: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type QueryResult = {
  query: string;
  places: PlaceLite[];
  // Total places Google returned for this query, before quality filters.
  // places.length ≤ rawCount; the gap is what the filters removed.
  rawCount: number;
  truncated: boolean;
  error: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  const callerRes = requireInternalCaller(req, env);
  if (!callerRes.ok) return callerRes.response;

  const keyRes = readGooglePlacesKey();
  if (!keyRes.ok) return keyRes.response;
  const apiKey = keyRes.key;

  const admin = adminClient(env);

  const bodyRes = await readJson<RequestBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const queries = Array.from(
    new Set(
      (body.queries ?? [])
        .map((q) => (typeof q === "string" ? q.trim() : ""))
        .filter((q) => q.length > 0),
    ),
  );
  if (queries.length === 0) {
    return json({ ok: false, error: "queries: empty" });
  }
  if (queries.length > MAX_QUERIES_PER_BATCH) {
    return json({
      ok: false,
      error: `queries: max ${MAX_QUERIES_PER_BATCH} per batch (got ${queries.length})`,
    });
  }

  const regionCode = ((body.regionCode ?? "MX") || "MX").toUpperCase();
  const maxResults = Math.min(
    MAX_RESULTS_PER_QUERY,
    Math.max(1, body.maxResultsPerQuery ?? MAX_RESULTS_PER_QUERY),
  );

  // Quality filters — clamp to sane ranges; 0 disables each one.
  const minRating = clamp(Number(body.minRating ?? 0), 0, 5);
  const minUserRatingCount = Math.max(0, Math.floor(Number(body.minUserRatingCount ?? 0)));

  // --- Run queries with bounded concurrency ---
  const results = new Array<QueryResult>(queries.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= queries.length) return;
      const q = queries[i];
      try {
        const fetched = await searchTextWithPagination(q, regionCode, maxResults, apiKey);
        const places = fetched.filter((p) =>
          passesQualityFilter(p, minRating, minUserRatingCount),
        );
        results[i] = {
          query: q,
          places,
          rawCount: fetched.length,
          truncated: fetched.length >= maxResults,
          error: null,
        };
      } catch (err) {
        results[i] = {
          query: q,
          places: [],
          rawCount: 0,
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queries.length) }, () => worker()),
  );

  // --- Dedupe ---
  const seen = new Set<string>();
  const uniquePlaces: PlaceLite[] = [];
  for (const r of results) {
    for (const p of r.places) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        uniquePlaces.push(p);
      }
    }
  }

  // --- Enrich with Mesita existence + timestamps ---
  let mesitaLookupError: string | null = null;
  let mesitaMatchCount = 0;
  if (uniquePlaces.length > 0) {
    try {
      const ids = uniquePlaces.map((p) => p.id);
      const { data, error } = await admin
        .from("projects_view")
        .select("google_place_id, created_at, updated_at")
        .in("google_place_id", ids);
      if (error) {
        mesitaLookupError = `Mesita lookup failed: ${error.message}`;
      } else {
        const byId = new Map<string, { created_at: string; updated_at: string }>();
        for (const row of data ?? []) {
          if (row.google_place_id) {
            byId.set(row.google_place_id, {
              created_at: row.created_at,
              updated_at: row.updated_at,
            });
          }
        }
        const applyEnrichment = (p: PlaceLite) => {
          const hit = byId.get(p.id);
          if (!hit) return;
          p.existsInMesita = true;
          p.createdAt = hit.created_at;
          p.updatedAt = hit.updated_at;
        };
        for (const p of uniquePlaces) applyEnrichment(p);
        for (const r of results) for (const p of r.places) applyEnrichment(p);
        mesitaMatchCount = byId.size;
      }
    } catch (err) {
      mesitaLookupError =
        err instanceof Error
          ? `Mesita lookup threw: ${err.message}`
          : `Mesita lookup threw: ${String(err)}`;
    }
  }

  // How many places the quality filters removed, summed across queries
  // (pre-dedupe — this is a "signal-to-noise" tally for the operator, not
  // a unique count).
  const rawTotal = results.reduce((n, r) => n + r.rawCount, 0);
  const keptTotal = results.reduce((n, r) => n + r.places.length, 0);
  const filteredOutCount = rawTotal - keptTotal;

  return json({
    ok: true,
    queries: results,
    uniquePlaces,
    uniqueCount: uniquePlaces.length,
    regionCode,
    maxResultsPerQuery: maxResults,
    minRating,
    minUserRatingCount,
    filteredOutCount,
    mesitaMatchCount,
    mesitaLookupError,
    caller: callerRes.callerName,
  });
});

// A place passes when it clears BOTH active filters. When a filter is off
// (0) it never rejects. When a filter is on but the place is missing that
// signal (null rating / null review count), it's rejected — an unrated
// place can't be shown to clear a rating floor, and the operator asked to
// see only places above the bar.
function passesQualityFilter(
  p: PlaceLite,
  minRating: number,
  minUserRatingCount: number,
): boolean {
  if (minRating > 0) {
    if (p.rating === null || p.rating < minRating) return false;
  }
  if (minUserRatingCount > 0) {
    if (p.userRatingCount === null || p.userRatingCount < minUserRatingCount) {
      return false;
    }
  }
  return true;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

async function searchTextWithPagination(
  textQuery: string,
  regionCode: string,
  maxResults: number,
  apiKey: string,
): Promise<PlaceLite[]> {
  const out: PlaceLite[] = [];
  let pageToken: string | undefined;
  let pagesFetched = 0;
  const wantedPages = Math.ceil(maxResults / PAGE_SIZE);

  while (pagesFetched < wantedPages && out.length < maxResults) {
    const body: Record<string, unknown> = {
      textQuery,
      pageSize: Math.min(PAGE_SIZE, maxResults - out.length),
    };
    if (regionCode) body.regionCode = regionCode;
    if (pageToken) body.pageToken = pageToken;

    const r = await fetch(GOOGLE_PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,nextPageToken",
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      throw await googleErrorFromResponse(r);
    }

    const data = (await r.json()) as {
      places?: Array<{
        id?: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
        rating?: number;
        userRatingCount?: number;
      }>;
      nextPageToken?: string;
    };

    for (const p of data.places ?? []) {
      if (!p.id) continue;
      out.push({
        id: p.id,
        displayName: p.displayName?.text ?? "",
        formattedAddress: p.formattedAddress ?? "",
        lat: typeof p.location?.latitude === "number" ? p.location.latitude : null,
        lng: typeof p.location?.longitude === "number" ? p.location.longitude : null,
        rating: typeof p.rating === "number" ? p.rating : null,
        userRatingCount:
          typeof p.userRatingCount === "number" ? p.userRatingCount : null,
        existsInMesita: false,
        createdAt: null,
        updatedAt: null,
      });
      if (out.length >= maxResults) break;
    }

    pageToken = data.nextPageToken;
    pagesFetched++;
    if (!pageToken) break;
  }

  return out;
}
