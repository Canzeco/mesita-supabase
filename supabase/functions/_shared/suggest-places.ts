// Shared suggest-places engine (Google + Mesita merge).
//
// Formerly the enricher suggest-places artificial-caller EF. It was only
// ever invoked by the three thin suggest facades (consumer-web-,
// business-web-, admin-web-suggest-places), so per the caller-nomenclature
// grammar (one endpoint = one caller) the HTTP hop didn't earn its cost on
// this latency-sensitive autocomplete path — the merge now runs in-process
// inside each facade (MESITA-55, mirroring the recommender absorb in
// MESITA-54). The old `enricher-suggest-places` cloud slug and the old-name
// facades (admin-/business-/consumer-suggest-places) were deleted from cloud
// on 2026-07-05 (MESITA-59 suggest cleanup); only the *-web- facades remain.
//
// Proxies Google Places (New) Autocomplete + a Mesita-side name ILIKE
// fallback in parallel, merges the two, and returns predictions tagged
// with per-row status (`not_in_mesita`, `web_listed`,
// `verified_partner_other`, `verified_partner_self`) so the UI can render
// the right badge. On-Mesita rows (any status other than `not_in_mesita`)
// additionally carry `mesitaId` + `mesitaSlug` (projects_view id + slug)
// so clients can navigate straight to the place row instead of
// re-matching predictions by name; Google-only predictions omit both.
//
// NOTE on `placeId`: in this response shape it is the GOOGLE Place ID
// (addendum 9 of MESITA-51 — the place-row UUID semantic lives in
// `mesitaId` here, so the two never collide in one key).
//
// The Google key never leaves Supabase — the facades resolve the caller's
// user id from the JWT and this module owns the rest.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { json } from "./http.ts";
import { adminClient, type EFEnv } from "./auth.ts";
import {
  classifyGoogleError,
  escapeIlike,
  fetchPlaceSignals,
  friendlyGoogleError,
  GOOGLE_PLACES_AUTOCOMPLETE_URL,
  readGooglePlacesKey,
} from "./google-places.ts";
import {
  type ChannelKey,
  type ChannelPolicy,
  evaluatePlaceForChannel,
  readChannelPolicy,
  autocompleteTypesForPolicy,
} from "./sourcing.ts";

export type SuggestPlacesArgs = {
  input?: string;
  sessionToken?: string;
  // Caller user id resolved from the end-user JWT by the facade. When
  // null, we can't flag verified_partner_self — only _other for any
  // owned row.
  callerUserId?: string | null;
  // When set, Google-only ("not_in_mesita") predictions are filtered against
  // app_settings.sourcing_config[sourcingChannel]. On-Mesita rows always
  // pass — they're already onboarded.
  sourcingChannel?: ChannelKey;
};

type PredictionStatus =
  | "not_in_mesita"
  | "web_listed"
  | "verified_partner_other"
  | "verified_partner_self";

type Prediction = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  status: PredictionStatus;
  // Present only on on-Mesita rows (status !== "not_in_mesita"):
  // projects_view id + slug so clients can navigate directly to the
  // place instead of fuzzy-matching by name. Google-only predictions
  // omit both.
  mesitaId?: string;
  mesitaSlug?: string;
};

// Runs the merge and returns the full HTTP response for the facade to
// send verbatim. `callerName` is echoed in the success envelope exactly
// like the old artificial caller did, so the client-visible shape is
// unchanged.
export async function suggestPlaces(
  env: EFEnv,
  callerName: string,
  args: SuggestPlacesArgs,
): Promise<Response> {
  const keyRes = readGooglePlacesKey();
  if (!keyRes.ok) return keyRes.response;
  const apiKey = keyRes.key;

  const input = (args.input ?? "").toString().trim();
  const sessionToken = (args.sessionToken ?? "").toString();
  const callerUserId = args.callerUserId ?? null;

  if (input.length < 2) return json({ ok: true, predictions: [] });
  if (!sessionToken) return json({ ok: false, error: "Missing sessionToken" });

  const admin = adminClient(env);

  const sourcingPolicy = args.sourcingChannel
    ? await readChannelPolicy(admin, args.sourcingChannel)
    : null;
  const autocompleteTypes = sourcingPolicy
    ? autocompleteTypesForPolicy(sourcingPolicy)
    : null;

  // Fire Google + Mesita searches in parallel. Either can fail
  // independently; we merge whatever comes back.
  const [googleResult, mesitaResult] = await Promise.allSettled([
    fetchGooglePredictions(input, sessionToken, apiKey, autocompleteTypes),
    fetchMesitaPredictions(admin, input, callerUserId),
  ]);

  if (googleResult.status === "rejected" && mesitaResult.status === "rejected") {
    return json({
      ok: false,
      code: "network_error",
      error:
        googleResult.reason instanceof Error
          ? googleResult.reason.message
          : "Search failed.",
    });
  }
  if (googleResult.status === "fulfilled" && googleResult.value.errorEnvelope) {
    return json(googleResult.value.errorEnvelope);
  }

  const googlePreds = googleResult.status === "fulfilled" ? googleResult.value.predictions : [];
  const mesitaPreds = mesitaResult.status === "fulfilled" ? mesitaResult.value : [];

  // Merge: Mesita-side hits take precedence (status wins for matching
  // placeId), then any remaining Google entries follow. Google's
  // structured text is nicer, so we keep its mainText/secondaryText but
  // graft Mesita's status (+ mesitaId/mesitaSlug) on top when the
  // placeId is in both sources.
  const byPlaceId = new Map<string, Prediction>();
  for (const p of mesitaPreds) byPlaceId.set(p.placeId, p);
  for (const p of googlePreds) {
    const existing = byPlaceId.get(p.placeId);
    byPlaceId.set(
      p.placeId,
      existing
        ? {
            ...p,
            status: existing.status,
            mesitaId: existing.mesitaId,
            mesitaSlug: existing.mesitaSlug,
          }
        : p,
    );
  }

  // Backfill status for predictions Google returned but the ILIKE
  // fallback missed (e.g., "Strana San Pedro" vs the place named just
  // "Strana"). Keys off placeId directly so the substring miss doesn't
  // matter.
  const orphanPlaceIds = Array.from(byPlaceId.values())
    .filter((p) => p.status === "not_in_mesita")
    .map((p) => p.placeId);
  if (orphanPlaceIds.length > 0) {
    const mesitaByPlaceId = await enrichByPlaceIds(admin, orphanPlaceIds, callerUserId);
    for (const [placeId, mesita] of mesitaByPlaceId) {
      const existing = byPlaceId.get(placeId);
      if (!existing) continue;
      byPlaceId.set(placeId, { ...existing, ...mesita });
    }
  }

  const predictions = Array.from(byPlaceId.values()).sort((a, b) => {
    const aIn = a.status !== "not_in_mesita";
    const bIn = b.status !== "not_in_mesita";
    return aIn === bIn ? 0 : aIn ? -1 : 1;
  });

  const filtered = sourcingPolicy
    ? await filterPredictionsBySourcing(predictions, sourcingPolicy, apiKey)
    : predictions;

  return json({ ok: true, predictions: filtered, caller: callerName });
}

// ── Google ────────────────────────────────────────────────────────────

async function fetchGooglePredictions(
  input: string,
  sessionToken: string,
  apiKey: string,
  includedPrimaryTypes: string[] | null,
): Promise<{
  predictions: Prediction[];
  errorEnvelope?: Record<string, unknown>;
}> {
  // Channel disabled or every family off → skip the Google leg entirely.
  if (includedPrimaryTypes !== null && includedPrimaryTypes.length === 0) {
    return { predictions: [] };
  }

  const body: Record<string, unknown> = { input, sessionToken };
  if (includedPrimaryTypes !== null) {
    body.includedPrimaryTypes = includedPrimaryTypes;
  } else {
    // Legacy path (no sourcing channel): broad static hospitality filter.
    body.includedPrimaryTypes = ["restaurant", "bar", "cafe", "night_club", "bakery"];
  }

  const r = await fetch(GOOGLE_PLACES_AUTOCOMPLETE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text();
    const code = classifyGoogleError(r.status, text);
    return {
      predictions: [],
      errorEnvelope: {
        ok: false,
        code,
        error: friendlyGoogleError(code, r.status, text),
        httpStatus: r.status,
      },
    };
  }

  const data = (await r.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId: string;
        structuredFormat?: {
          mainText?: { text?: string };
          secondaryText?: { text?: string };
        };
        text?: { text?: string };
      };
    }>;
  };

  const predictions = (data.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map<Prediction>((p) => ({
      placeId: p.placeId,
      mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
      secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
      status: "not_in_mesita",
    }))
    .filter((p) => p.placeId && p.mainText);
  return { predictions };
}

// ── Mesita-side fallback ──────────────────────────────────────────────

async function fetchMesitaPredictions(
  admin: SupabaseClient,
  input: string,
  callerId: string | null,
): Promise<Prediction[]> {
  // ILIKE prefix-and-contains so "strana" finds both "Strana" and "Casa
  // Strana, Monterrey". Limit small — Google is the primary surface; this
  // is a fallback for the long-tail case where Google misses.
  const { data, error } = await admin
    .from("projects_view")
    .select("id, slug, google_place_id, name, address")
    .ilike("name", `%${escapeIlike(input)}%`)
    .not("google_place_id", "is", null)
    .limit(8);
  if (error) {
    console.error("[suggest-places] mesita search:", error.message);
    return [];
  }
  type Row = {
    id: string;
    slug: string;
    google_place_id: string;
    name: string;
    address: string | null;
  };
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  const statuses = await statusesForPlaces(admin, rows, callerId);
  return rows.map<Prediction>((v) => ({
    placeId: v.google_place_id,
    mainText: v.name,
    secondaryText: v.address ?? "Already on Mesita",
    status: statuses.get(v.google_place_id) ?? "web_listed",
    mesitaId: v.id,
    mesitaSlug: v.slug,
  }));
}

async function enrichByPlaceIds(
  admin: SupabaseClient,
  placeIds: string[],
  callerId: string | null,
): Promise<Map<string, Pick<Prediction, "status" | "mesitaId" | "mesitaSlug">>> {
  const { data, error } = await admin
    .from("projects_view")
    .select("id, slug, google_place_id")
    .in("google_place_id", placeIds);
  if (error) {
    console.error("[suggest-places] placeId enrichment:", error.message);
    return new Map();
  }
  type Row = { id: string; slug: string; google_place_id: string };
  const rows = (data ?? []) as Row[];
  const statuses = await statusesForPlaces(admin, rows, callerId);
  const out = new Map<string, Pick<Prediction, "status" | "mesitaId" | "mesitaSlug">>();
  for (const r of rows) {
    out.set(r.google_place_id, {
      status: statuses.get(r.google_place_id) ?? "web_listed",
      mesitaId: r.id,
      mesitaSlug: r.slug,
    });
  }
  return out;
}

// One owner-lookup pass over a place-row set, returning the per-placeId
// PredictionStatus. `web_listed` for unowned rows;
// `verified_partner_self/_other` for owned ones depending on whether the
// caller (resolved by the facade before this call) is the owner.
async function statusesForPlaces(
  admin: SupabaseClient,
  rows: Array<{ id: string; google_place_id: string }>,
  callerId: string | null,
): Promise<Map<string, PredictionStatus>> {
  if (rows.length === 0) return new Map();
  const { data, error } = await admin
    .from("project_members")
    .select("project_id, business_id")
    .in("project_id", rows.map((r) => r.id))
    .eq("role", "owner");
  if (error) {
    console.error("[suggest-places] owner lookup:", error.message);
  }
  const ownerByPlace = new Map<string, string>();
  for (const m of (data ?? []) as Array<{
    project_id: string;
    business_id: string;
  }>) {
    ownerByPlace.set(m.project_id, m.business_id);
  }
  const out = new Map<string, PredictionStatus>();
  for (const v of rows) {
    const ownerId = ownerByPlace.get(v.id);
    out.set(
      v.google_place_id,
      ownerId
        ? callerId && ownerId === callerId
          ? "verified_partner_self"
          : "verified_partner_other"
        : "web_listed",
    );
  }
  return out;
}

// Apply the sourcing channel policy to Google-only predictions. On-Mesita
// rows always pass — they're already onboarded. For not_in_mesita rows,
// batch-fetch primaryType + rating + reviewCount (Autocomplete omits them)
// and drop any that fail evaluatePlaceForChannel.
async function filterPredictionsBySourcing(
  predictions: Prediction[],
  policy: ChannelPolicy,
  apiKey: string,
): Promise<Prediction[]> {
  const googleOnly = predictions.filter((p) => p.status === "not_in_mesita");
  if (googleOnly.length === 0) return predictions;

  const signalsByPlaceId = new Map<
    string,
    { primaryType: string | null; rating: number | null; reviewCount: number | null }
  >();
  await Promise.all(
    googleOnly.map(async (p) => {
      const sig = await fetchPlaceSignals(p.placeId, apiKey);
      if (sig) signalsByPlaceId.set(p.placeId, sig);
    }),
  );

  return predictions.filter((p) => {
    if (p.status !== "not_in_mesita") return true;
    const sig = signalsByPlaceId.get(p.placeId);
    if (!sig) return false;
    return evaluatePlaceForChannel(policy, sig).eligible;
  });
}
