// consumer-web-ask-memo — Memo, the consumer AI concierge.
//
// Memo is Mesita's third agent (alongside the Enricher/Atlas and the
// Reservationist). Unlike those two — n8n workflows — Memo lives here, as an
// Edge Function, because it sits on the consumer's synchronous chat path.
//
// One turn of the concierge chat runs a three-source pipeline in parallel and
// merges the results:
//
//   1. PERPLEXITY (sonar-pro, web-grounded)  → the natural-language ANSWER.
//      This is the real, functional brain of the chat: it can answer any
//      question, reason about "rooftop date under $$$", compare neighborhoods,
//      etc., and returns citations + follow-up questions.
//
//   2. GOOGLE PLACES (Text Search, New)      → real place CANDIDATES.
//      The raw query (location-biased when the client sends lat/lng) is thrown
//      at Google Text Search; results are sorted by Google star rating. This
//      realizes asks like "top 3 bars near me" — Google understands the query,
//      we rank by stars.
//
//   3. MESITA DB (projects_view)             → which candidates are ON MESITA.
//      Google place ids are cross-referenced against our catalog so cards get
//      tagged on-Mesita (partner/web-listed) vs not, and a name search surfaces
//      on-platform spots Google may have missed. (Future: RAG over the catalog
//      swaps in here.)
//
// If Google is unconfigured/empty we fall back to a random sample of live
// Mesita places so the chat still ships suggestion cards — "just mocks" for
// the place rail, while the TEXT stays fully real.
//
// Secrets: PERPLEXITY_KEY (shared with Atlas/ADEA) + GMP_KEY (Google Maps
// Platform, shared with the enricher). Neither key ever leaves Supabase.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getOptionalAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import {
  callPerplexityChat,
  type PplxMessage,
} from "../_shared/perplexity-chat.ts";
import {
  classifyGoogleError,
  escapeIlike,
  friendlyGoogleError,
  GOOGLE_PLACES_TEXT_SEARCH_URL,
  readGooglePlacesKey,
} from "../_shared/google-places.ts";

// ── Types ──────────────────────────────────────────────────────────────

type PredictionStatus =
  | "not_in_mesita"
  | "web_listed"
  | "verified_partner_other"
  | "verified_partner_self";

// Mirrors the consumer PlacePrediction contract (see consumer-web-suggest-
// places) so the same PredictionRow renders these with no client changes.
// `rating`/`ratingCount` are Memo extras the client may ignore.
type Prediction = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  status: PredictionStatus;
  mesitaId?: string;
  mesitaSlug?: string;
  rating?: number | null;
  ratingCount?: number | null;
};

type MemoBody = {
  query?: string;
  latitude?: number;
  longitude?: number;
  // Prior turns for conversational context (most recent last).
  history?: { role?: unknown; content?: unknown }[];
};

// ── Tuning ─────────────────────────────────────────────────────────────

const MAX_CARDS = 6;
const MAX_HISTORY = 8;
const GOOGLE_RADIUS_M = 8000;

const SYSTEM_PROMPT = `You are Memo, Mesita's warm, sharp local concierge for dining, nightlife, cafés, and experiences — with deep taste for Monterrey and Mexico generally, but able to help anywhere.

Style:
- Reply in the SAME language the user wrote in (Spanish or English). Default to a friendly, concise voice.
- Keep it SHORT: 2–4 sentences, mobile-chat length. Be opinionated and specific, not a bland list.
- A separate UI rail shows tappable place cards below your message, so DON'T dump a long numbered list of places — give a quick, confident take and let the cards carry the details.
- You can answer ANY question (hours, neighborhoods, what to order, "is X good for a date", trivia), but stay in the helpful-concierge lane.
- Never invent specific addresses, prices, or phone numbers you aren't sure of; speak generally when unsure.`;

// ── Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  const bodyRes = await readJson<MemoBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const query = (body.query ?? "").toString().trim();
  if (query.length < 2) {
    return json({ ok: false, error: "Ask me something first." }, 400);
  }

  const lat = typeof body.latitude === "number" ? body.latitude : null;
  const lng = typeof body.longitude === "number" ? body.longitude : null;

  // Optional auth — Memo works signed-out; a user id lets us personalise later.
  const { user } = await getOptionalAuthedUser(req, env);

  const admin = adminClient(env);
  const perplexityKey = Deno.env.get("PERPLEXITY_KEY") ?? "";

  // Fan out the two slow legs (Perplexity + Google) in parallel; neither can
  // sink the other.
  const [answerLeg, placesLeg] = await Promise.allSettled([
    answerWithPerplexity(perplexityKey, query, lat, lng, body.history),
    candidatePlaces(admin, query, lat, lng),
  ]);

  const perplexity =
    answerLeg.status === "fulfilled" ? answerLeg.value : null;
  const placeResult =
    placesLeg.status === "fulfilled"
      ? placesLeg.value
      : { predictions: [] as Prediction[], mocked: false };

  const predictions = placeResult.predictions.slice(0, MAX_CARDS);
  const onMesita = predictions.filter((p) => p.status !== "not_in_mesita").length;
  const fromGoogle = predictions.length - onMesita;

  const answer =
    perplexity?.text && perplexity.text.length > 0
      ? perplexity.text
      : fallbackAnswer(query, onMesita, fromGoogle, placeResult.mocked);

  return json({
    ok: true,
    answer,
    predictions,
    related: perplexity?.related ?? [],
    citations: perplexity?.citations ?? [],
    mocked: placeResult.mocked,
    userId: user?.id ?? null,
  });
});

// ── Leg 1: Perplexity answer ───────────────────────────────────────────

async function answerWithPerplexity(
  key: string,
  query: string,
  lat: number | null,
  lng: number | null,
  history: MemoBody["history"],
): Promise<{ text: string; related: string[]; citations: string[] } | null> {
  if (!key) return null;

  const messages: PplxMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  // Clamp + sanitize prior turns.
  for (const turn of (history ?? []).slice(-MAX_HISTORY)) {
    const role = turn?.role === "assistant" ? "assistant" : "user";
    const content = typeof turn?.content === "string" ? turn.content.trim() : "";
    if (content) messages.push({ role, content });
  }

  const locHint =
    lat !== null && lng !== null
      ? ` (the user is near latitude ${lat.toFixed(4)}, longitude ${lng.toFixed(4)})`
      : "";
  messages.push({ role: "user", content: `${query}${locHint}` });

  const res = await callPerplexityChat(key, messages, {
    model: "sonar-pro",
    maxTokens: 700,
    temperature: 0.3,
    returnRelated: true,
  });
  if (!res) return null;
  return { text: res.text, related: res.related, citations: res.citations };
}

// ── Leg 2: place candidates (Google Text Search + Mesita merge) ─────────

async function candidatePlaces(
  admin: SupabaseClient,
  query: string,
  lat: number | null,
  lng: number | null,
): Promise<{ predictions: Prediction[]; mocked: boolean }> {
  const keyRes = readGooglePlacesKey();

  let googlePreds: Prediction[] = [];
  if (keyRes.ok) {
    googlePreds = await googleTextSearch(keyRes.key, query, lat, lng);
  }

  // Cross-reference Google hits against the Mesita catalog by google_place_id
  // so on-platform spots get the right badge + navigable ids.
  if (googlePreds.length > 0) {
    const byPlaceId = await mesitaByGooglePlaceIds(
      admin,
      googlePreds.map((p) => p.placeId),
    );
    for (const p of googlePreds) {
      const m = byPlaceId.get(p.placeId);
      if (m) {
        p.status = m.status;
        p.mesitaId = m.mesitaId;
        p.mesitaSlug = m.mesitaSlug;
        if (!p.secondaryText) p.secondaryText = "On Mesita";
      }
    }
  }

  // Surface on-Mesita spots by name too (catches ones Google missed / that
  // aren't in the Google result set for this phrasing).
  const mesitaPreds = await mesitaByName(admin, query);

  // Merge, de-dupe by placeId, rank Mesita-first then by Google rating.
  const merged = new Map<string, Prediction>();
  for (const p of mesitaPreds) merged.set(p.placeId, p);
  for (const p of googlePreds) if (!merged.has(p.placeId)) merged.set(p.placeId, p);

  let predictions = Array.from(merged.values()).sort((a, b) => {
    const aIn = a.status !== "not_in_mesita" ? 1 : 0;
    const bIn = b.status !== "not_in_mesita" ? 1 : 0;
    if (aIn !== bIn) return bIn - aIn;
    return (b.rating ?? 0) - (a.rating ?? 0);
  });

  // Nothing real to show → fall back to a random sample of live Mesita places
  // so the chat still renders suggestion cards ("mock" rail, real rows).
  let mocked = false;
  if (predictions.length === 0) {
    predictions = await sampleMesitaPlaces(admin);
    mocked = predictions.length > 0;
  }

  return { predictions, mocked };
}

async function googleTextSearch(
  key: string,
  query: string,
  lat: number | null,
  lng: number | null,
): Promise<Prediction[]> {
  const reqBody: Record<string, unknown> = {
    textQuery: query,
    maxResultCount: 10,
    regionCode: "MX",
  };
  if (lat !== null && lng !== null) {
    reqBody.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: GOOGLE_RADIUS_M,
      },
    };
  }

  let r: Response;
  try {
    r = await fetch(GOOGLE_PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount",
      },
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    console.error("[ask-memo] google fetch threw:", (e as Error).message);
    return [];
  }

  if (!r.ok) {
    const t = await r.text();
    console.error(
      "[ask-memo] google text search:",
      friendlyGoogleError(classifyGoogleError(r.status, t), r.status, t),
    );
    return [];
  }

  const d = (await r.json()) as {
    places?: {
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      rating?: number;
      userRatingCount?: number;
    }[];
  };

  return (d.places ?? [])
    .map<Prediction>((p) => ({
      placeId: p.id ?? "",
      mainText: p.displayName?.text ?? "",
      secondaryText: p.formattedAddress ?? "",
      status: "not_in_mesita",
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
    }))
    .filter((p) => p.placeId && p.mainText)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
}

async function mesitaByGooglePlaceIds(
  admin: SupabaseClient,
  placeIds: string[],
): Promise<
  Map<string, { status: PredictionStatus; mesitaId: string; mesitaSlug: string }>
> {
  const out = new Map<
    string,
    { status: PredictionStatus; mesitaId: string; mesitaSlug: string }
  >();
  if (placeIds.length === 0) return out;

  const { data, error } = await admin
    .from("projects_view")
    .select("id, slug, google_place_id, listing_type")
    .in("google_place_id", placeIds);
  if (error) {
    console.error("[ask-memo] mesita placeId lookup:", error.message);
    return out;
  }
  for (const row of (data ?? []) as {
    id: string;
    slug: string;
    google_place_id: string;
    listing_type: string | null;
  }[]) {
    out.set(row.google_place_id, {
      status: row.listing_type === "partner"
        ? "verified_partner_other"
        : "web_listed",
      mesitaId: row.id,
      mesitaSlug: row.slug,
    });
  }
  return out;
}

async function mesitaByName(
  admin: SupabaseClient,
  query: string,
): Promise<Prediction[]> {
  const { data, error } = await admin
    .from("projects_view")
    .select(
      "id, slug, name, address, google_place_id, listing_type, google_stars_overall, status",
    )
    .ilike("name", `%${escapeIlike(query)}%`)
    .in("status", ["active", "lead"])
    .limit(4);
  if (error) {
    console.error("[ask-memo] mesita name search:", error.message);
    return [];
  }
  return ((data ?? []) as {
    id: string;
    slug: string;
    name: string;
    address: string | null;
    google_place_id: string | null;
    listing_type: string | null;
    google_stars_overall: number | null;
  }[]).map<Prediction>((row) => ({
    // Prefer the Google id as the card key (keeps it aligned with the Google
    // leg for de-dupe); fall back to the Mesita uuid when there's no Google id.
    placeId: row.google_place_id ?? row.id,
    mainText: row.name,
    secondaryText: row.address ?? "On Mesita",
    status: row.listing_type === "partner"
      ? "verified_partner_other"
      : "web_listed",
    mesitaId: row.id,
    mesitaSlug: row.slug,
    rating: row.google_stars_overall,
  }));
}

async function sampleMesitaPlaces(
  admin: SupabaseClient,
): Promise<Prediction[]> {
  const { data, error } = await admin
    .from("projects_view")
    .select(
      "id, slug, name, address, google_place_id, listing_type, google_stars_overall",
    )
    .eq("status", "active")
    .order("google_stars_overall", { ascending: false, nullsFirst: false })
    .limit(24);
  if (error) {
    console.error("[ask-memo] mesita sample:", error.message);
    return [];
  }
  const rows = (data ?? []) as {
    id: string;
    slug: string;
    name: string;
    address: string | null;
    google_place_id: string | null;
    listing_type: string | null;
    google_stars_overall: number | null;
  }[];

  // Shuffle so the "mock" rail feels fresh turn to turn, then take a handful.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.slice(0, MAX_CARDS).map<Prediction>((row) => ({
    placeId: row.google_place_id ?? row.id,
    mainText: row.name,
    secondaryText: row.address ?? "On Mesita",
    status: row.listing_type === "partner"
      ? "verified_partner_other"
      : "web_listed",
    mesitaId: row.id,
    mesitaSlug: row.slug,
    rating: row.google_stars_overall,
  }));
}

// ── Fallback prose (Perplexity unavailable) ────────────────────────────

function fallbackAnswer(
  query: string,
  onMesita: number,
  fromGoogle: number,
  mocked: boolean,
): string {
  if (onMesita === 0 && fromGoogle === 0) {
    return `I couldn't pull spots for “${query}” right now — try a place name, a dish, or a neighborhood.`;
  }
  if (mocked) {
    return `My concierge brain is catching its breath, but here are a few Mesita spots you might like while I reconnect.`;
  }
  const parts: string[] = [];
  if (onMesita > 0) parts.push(`${onMesita} on Mesita`);
  if (fromGoogle > 0) parts.push(`${fromGoogle} from Google`);
  return `Here's what I'd check out for “${query}” — ${parts.join(" and ")}. Tap a Google spot's Add and I'll build its Mesita profile.`;
}
