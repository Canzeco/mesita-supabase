// consumer-web-ask-memo — Memo, the consumer AI concierge.
//
// Memo is Mesita's third agent (alongside the Enricher/Atlas and the
// Reservationist). Unlike those two — n8n workflows — Memo lives here, as an
// Edge Function, because it sits on the consumer's synchronous chat path.
//
// One turn of the concierge chat:
//
//   1. GOOGLE PLACES (Text Search, New) + MESITA DB → the place CANDIDATES.
//      Only when the ask is place-seeking (isPlaceSeeking). Google understands
//      the query (location-biased on lat/lng); results are type-filtered to
//      Mesita's hospitality universe and ranked open-now-first then by rating.
//      Google ids are cross-referenced against projects_view so cards get
//      tagged on-Mesita (partner/web-listed) vs not, and a name search surfaces
//      on-platform spots Google missed. (Future: RAG over the catalog here.)
//
//   2. PERPLEXITY (sonar-pro, web-grounded) → the natural-language ANSWER.
//      The candidates from step 1 are fed to Perplexity as context so its
//      recommendation names the ACTUAL cards the user sees — the prose and the
//      rail stay coherent instead of drifting apart. It still adds web-grounded
//      color (what to order, vibe) + citations + follow-up questions, and can
//      answer ANY question. Non-place-seeking turns skip step 1 and reply text-
//      only. Hidden context feeds the user's location + local time so Memo
//      favours open, time-appropriate spots.
//
// No random-sample fallback: no genuine match → empty rail + text-only reply.
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
import { evaluatePlaceForChannel, readChannelPolicy, type ChannelPolicy } from "../_shared/sourcing.ts";
// Local-time primitives shared with the Home recommenders (PR #214). mexicoZone
// (lng → IANA zone) and openScore (open/unknown/closed → rank weight) used to be
// duplicated here; import them so the timezone bands + "demote, don't hide"
// weighting stay in lock-step across memo + swipe + map. daypartLabel /
// localMoment below are memo's own prompt-facing display and stay local.
import { mexicoZone, openScore } from "../_shared/local-time.ts";

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
  // Memo extra: Google's live open/closed state, used to demote closed spots
  // at the current local hour (null = unknown, don't penalise).
  openNow?: boolean | null;
};

type MemoBody = {
  query?: string;
  latitude?: number;
  longitude?: number;
  // Prior turns for conversational context (most recent last).
  history?: { role?: unknown; content?: unknown }[];
};

// ── Tuning ─────────────────────────────────────────────────────────────

const MAX_CARDS = 3;
const MAX_HISTORY = 8;
const GOOGLE_RADIUS_M = 8000;

const SYSTEM_PROMPT = `You are Memo, the AI of Mesita — a warm, sharp local concierge for dining, nightlife, cafés, and experiences, with deep taste for Monterrey and Mexico generally, but able to help anywhere.

Style:
- Reply in PLAIN TEXT — the chat renders raw, so NO markdown: no **bold**, no *italics*, no # headings, no backticks, no bullet syntax. Emojis are welcome and encouraged (they render fine).
- Reply in the SAME language the user wrote in (Spanish or English). Default to a friendly, concise voice.
- Keep it SHORT: 2–4 sentences, mobile-chat length. Be opinionated and specific, not a bland list.
- Place cards are OPTIONAL. They only appear when the user is genuinely looking for places, and there may be anywhere from zero to three — never assume there are three, and never pad. For general questions (definitions, how things work, trivia, hours, what to order), just answer conversationally and do NOT refer to cards. When cards do appear, give a quick confident take and let them carry the details — don't dump a long numbered list.
- You can answer ANY question, but stay in the helpful-concierge lane.
- Be TIME-AWARE. A hidden context note tells you the user's local time and daypart. Recommend spots that are open and fit the moment — coffee/breakfast in the early morning, lunch midday, dinner/drinks in the evening, late-night spots after hours. If the user asks for something usually closed right now (a brunch café at 2am, a bar at 7am), say so warmly and offer an open alternative. Never repeat the context note back verbatim.
- You may know a few basics about the user (first name, age, sex, and their location). Use them lightly — greet by first name when it feels natural and tailor suggestions to where and who they are — but never recite their personal details back to them.
- Never invent specific addresses, prices, or phone numbers you aren't sure of; speak generally when unsure.`;

// Memo's system prompt is operator-tunable: the admin console's Memo Config page
// writes app_settings.memo_instructions (seeded with SYSTEM_PROMPT above). Read
// the live value, falling back to the in-code default whenever the row is blank
// or the read fails — a config hiccup must never sink Memo's voice.
async function readMemoSystemPrompt(admin: SupabaseClient): Promise<string> {
  try {
    const { data, error } = await admin
      .from("app_settings")
      .select("memo_instructions")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      console.error("[ask-memo] memo_instructions read:", error.message);
      return SYSTEM_PROMPT;
    }
    const custom = (data?.memo_instructions ?? "").toString().trim();
    return custom.length > 0 ? custom : SYSTEM_PROMPT;
  } catch (e) {
    console.error("[ask-memo] memo_instructions threw:", (e as Error).message);
    return SYSTEM_PROMPT;
  }
}

// Whole years from an ISO birthday (YYYY-MM-DD), or null when absent/implausible.
function ageFromBirthday(birthday: unknown): number | null {
  if (typeof birthday !== "string" || birthday.length < 4) return null;
  const dob = new Date(birthday);
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age >= 13 && age <= 120 ? age : null;
}

// A short profile clause for Memo's hidden context — the signed-in user's first
// name, age and sex from the consumers profile (keyed by auth user id). Only the
// parts we actually have are included; returns null when there's nothing useful.
// Never let a profile miss sink the answer.
async function readConsumerContext(
  admin: SupabaseClient,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from("consumers")
      .select("first_name, full_name, sex, birthday")
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("[ask-memo] profile read:", error.message);
      return null;
    }
    const bits: string[] = [];
    const name = ((data.first_name ?? data.full_name ?? "") as string)
      .trim()
      .split(/\s+/)[0];
    if (name) bits.push(`named ${name}`);
    const age = ageFromBirthday(data.birthday);
    if (age) bits.push(`${age} years old`);
    const sex = (data.sex ?? "").toString().trim().toLowerCase();
    if (sex) bits.push(sex);
    return bits.length > 0 ? bits.join(", ") : null;
  } catch (e) {
    console.error("[ask-memo] profile threw:", (e as Error).message);
    return null;
  }
}

// Memo only attaches place cards when the ask is actually place-seeking; pure
// knowledge/chat turns ("what does al pastor mean", "how do tips work") get a
// text-only reply. Heuristic, bilingual (ES/EN): explicit place words always
// search; an otherwise bare question reads as definitional → text only.
const PLACE_INTENT =
  /\b(near|nearby|around|close|best|top|recommend|recommendation|where|spot|spots|place|places|bar|bars|club|clubs|nightlife|restaurant|restaurants|cafe|coffee|taco|tacos|dinner|lunch|brunch|breakfast|drink|drinks|rooftop|date night|eat|food|hungry|open now|tonight|cerca|cercano|mejor|mejores|dónde|donde|lugar|lugares|antro|antros|comer|cena|cenar|comida|desayun|almuerz|bares|restaurante|café|reserva|abierto|esta noche|recomienda|recomiénda)\b/i;
const DEFINITIONAL =
  /^\s*(what|why|how|who|when|which|is|are|does|do|can|should|explain|tell me|qué|que|por qué|porque|cómo|como|quién|quien|cuándo|cuando|cuál|cual|explica|dime)\b/i;

function isPlaceSeeking(query: string): boolean {
  if (PLACE_INTENT.test(query)) return true; // explicit place words win
  if (DEFINITIONAL.test(query)) return false; // a bare question → text only
  return true; // short noun-ish fragments ("sushi san pedro") read as searches
}

// ── Local time ("when") ─────────────────────────────────────────────────
//
// The "where" (lat/lng) was already fed to Memo; the "when" was missing, so it
// pitched dinner at 5am. We derive the user's LOCAL moment from their lng and
// inject it as hidden prompt context + use it to demote closed spots.
//
// mexicoZone (lng → IANA zone) and openScore (open/unknown/closed → rank
// weight) are imported from ../_shared/local-time.ts so memo, swipe and map
// share one timezone-band + "demote, don't hide" implementation.

function daypartLabel(hour: number): string {
  if (hour < 5) return "the middle of the night";
  if (hour < 11) return "morning";
  if (hour < 15) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "late night";
}

// Current local clock + daypart for the user, e.g.
// { clock: "Monday, 5:12 AM", daypart: "the middle of the night" }.
function localMoment(lng: number | null): { clock: string; daypart: string } {
  const timeZone = mexicoZone(lng);
  const now = new Date();
  let clock = "";
  let hour = 12;
  try {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(now);
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).format(now);
    hour = parseInt(hourStr, 10) % 24;
  } catch {
    // Bad zone → leave neutral midday defaults; never sink the answer over time.
  }
  return { clock, daypart: daypartLabel(hour) };
}

// The consumer chat renders Memo's reply as RAW TEXT, so any markdown the
// model emits (**bold**, *italics*, `code`, # headings, [links](url)) leaks
// through as literal symbols. Strip the formatting markers but keep the words —
// and keep emojis, accents (á/ñ), and ¡¿ punctuation untouched.
function toPlainText(s: string): string {
  return s
    // Links: [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    // Bold / italic / strikethrough wrappers → their inner text
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2")
    // Inline code / fenced code → inner text
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    // Heading (#) and blockquote (>) markers at line start
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    // Any stray emphasis/heading/code markers left over
    .replace(/[*_`#]/g, "")
    .trim();
}

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

  // Only look up places when the ask is actually place-seeking — a definition
  // or general question gets a text-only reply (no forced cards).
  const placeSeeking = isPlaceSeeking(query);

  // Memo's persona is operator-tunable from the admin console (Memo Config →
  // app_settings.memo_instructions). Kick the read off now so it overlaps the
  // Google leg; SYSTEM_PROMPT is the fallback when the row is blank/unreadable,
  // so Memo never loses its voice.
  const systemPromptPromise = readMemoSystemPrompt(admin);

  // Signed-in users get a personalised concierge: Memo learns their first name,
  // age and sex from the consumers profile so it can greet by name and tailor
  // suggestions. Read concurrently; signed-out (or a miss) just means no profile
  // context — location still flows from the client either way.
  const profileCtxPromise = user
    ? readConsumerContext(admin, user.id)
    : Promise.resolve<string | null>(null);

  // Candidates FIRST (place-seeking only), so Perplexity can write its
  // recommendation ABOUT the exact cards the user sees — prose and rail stay
  // coherent. The Google leg is ~0.5s; worth the small serialization for a
  // reply that names the real cards. Never let it sink the answer.
  let predictions: Prediction[] = [];
  if (placeSeeking) {
    try {
      const memoPolicy = await readChannelPolicy(admin, "memo_search");
      const placeResult = await candidatePlaces(admin, query, lat, lng, memoPolicy);
      predictions = placeResult.predictions.slice(0, MAX_CARDS);
    } catch (e) {
      console.error("[ask-memo] places leg:", (e as Error).message);
    }
  }
  const onMesita = predictions.filter((p) => p.status !== "not_in_mesita").length;
  const fromGoogle = predictions.length - onMesita;

  const [systemPrompt, profileCtx] = await Promise.all([
    systemPromptPromise,
    profileCtxPromise,
  ]);
  const perplexity = await answerWithPerplexity(
    perplexityKey,
    systemPrompt,
    query,
    lat,
    lng,
    profileCtx,
    body.history,
    predictions,
  );

  const answer = toPlainText(
    perplexity?.text && perplexity.text.length > 0
      ? perplexity.text
      : fallbackAnswer(query, onMesita, fromGoogle, placeSeeking),
  );

  return json({
    ok: true,
    answer,
    predictions,
    related: perplexity?.related ?? [],
    citations: perplexity?.citations ?? [],
    userId: user?.id ?? null,
  });
});

// ── Leg 1: Perplexity answer ───────────────────────────────────────────

async function answerWithPerplexity(
  key: string,
  systemPrompt: string,
  query: string,
  lat: number | null,
  lng: number | null,
  profileCtx: string | null,
  history: MemoBody["history"],
  candidates: Prediction[],
): Promise<{ text: string; related: string[]; citations: string[] } | null> {
  if (!key) return null;

  const messages: PplxMessage[] = [{ role: "system", content: systemPrompt }];

  // Clamp + sanitize prior turns.
  for (const turn of (history ?? []).slice(-MAX_HISTORY)) {
    const role = turn?.role === "assistant" ? "assistant" : "user";
    const content = typeof turn?.content === "string" ? turn.content.trim() : "";
    if (content) messages.push({ role, content });
  }

  // Hidden context the model reasons over but must not echo: the user's
  // "where" (location) AND "when" (local time + daypart). Feeding the moment is
  // what stops Memo pitching dinner at 5am — it can now favour open, time-fit
  // spots and flag off-hours asks.
  const { clock, daypart } = localMoment(lng);
  const ctxBits: string[] = [];
  if (profileCtx) ctxBits.push(profileCtx);
  if (lat !== null && lng !== null) {
    ctxBits.push(`near latitude ${lat.toFixed(4)}, longitude ${lng.toFixed(4)}`);
  }
  if (clock) ctxBits.push(`local time ${clock} (${daypart})`);
  const ctx = ctxBits.length > 0
    ? ` [context, do not repeat back: the user is ${ctxBits.join("; ")}. `
      + `Favour places open and appropriate for this time of day.]`
    : "";

  // Feed the exact cards the user will see so the recommendation stays
  // coherent with the rail — Memo names the real cards instead of drifting to
  // web-only spots. Empty/absent when the ask isn't place-seeking or nothing
  // matched.
  messages.push({ role: "user", content: `${query}${ctx}${candidateBlock(candidates)}` });

  const res = await callPerplexityChat(key, messages, {
    model: "sonar-pro",
    maxTokens: 700,
    temperature: 0.3,
    returnRelated: true,
  });
  if (!res) return null;
  return { text: res.text, related: res.related, citations: res.citations };
}

// Hidden prompt block listing the actual place cards (max 6) so Perplexity
// recommends FROM them. Not echoed back; the model weaves 1–3 in naturally.
function candidateBlock(candidates: Prediction[]): string {
  if (candidates.length === 0) return "";
  const lines = candidates.slice(0, MAX_CARDS).map((c, i) => {
    const bits: string[] = [c.mainText];
    if (c.secondaryText) bits.push(c.secondaryText.split(",")[0].trim());
    if (typeof c.rating === "number") bits.push(`★${c.rating.toFixed(1)}`);
    if (c.status !== "not_in_mesita") bits.push("on Mesita");
    if (c.openNow === true) bits.push("open now");
    else if (c.openNow === false) bits.push("closed now");
    return `${i + 1}. ${bits.join(" · ")}`;
  });
  return (
    ` [cards shown to the user below your reply — recommend from THESE so your` +
    ` words match the cards; weave 1–3 in naturally, don't list them all` +
    ` mechanically, and prefer open ones. If none truly fit the ask, say so` +
    ` briefly and give general guidance:\n${lines.join("\n")}]`
  );
}

// ── Leg 2: place candidates (Google Text Search + Mesita merge) ─────────

async function candidatePlaces(
  admin: SupabaseClient,
  query: string,
  lat: number | null,
  lng: number | null,
  memoPolicy: ChannelPolicy,
): Promise<{ predictions: Prediction[] }> {
  const keyRes = readGooglePlacesKey();

  let googlePreds: Prediction[] = [];
  if (keyRes.ok) {
    googlePreds = await googleTextSearch(keyRes.key, query, lat, lng, memoPolicy);
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

  const predictions = Array.from(merged.values()).sort((a, b) => {
    const aIn = a.status !== "not_in_mesita" ? 1 : 0;
    const bIn = b.status !== "not_in_mesita" ? 1 : 0;
    if (aIn !== bIn) return bIn - aIn; // Mesita-first stays the top business rule
    const openDelta = openScore(b.openNow) - openScore(a.openNow);
    if (openDelta !== 0) return openDelta; // then open-now over closed
    return (b.rating ?? 0) - (a.rating ?? 0);
  });

  // No random-sample fallback: if nothing genuinely matches, we return an
  // empty rail and Memo replies text-only. Better a clean answer than
  // irrelevant cards (a department store for a nightlife ask).
  return { predictions };
}

async function googleTextSearch(
  key: string,
  query: string,
  lat: number | null,
  lng: number | null,
  memoPolicy: ChannelPolicy,
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
        // openNow lets us demote closed spots at the current hour. No extra
        // billing: rating/userRatingCount already put this call on the
        // Enterprise+Atmosphere SKU; currentOpeningHours is a lower tier.
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.primaryType,places.types,places.currentOpeningHours.openNow",
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
      primaryType?: string;
      types?: string[];
      currentOpeningHours?: { openNow?: boolean };
    }[];
  };

  return (d.places ?? [])
    .filter((p) =>
      evaluatePlaceForChannel(memoPolicy, {
        primaryType: p.primaryType ?? null,
        rating: p.rating ?? null,
        reviewCount: p.userRatingCount ?? null,
      }).eligible
    )
    .map<Prediction>((p) => ({
      placeId: p.id ?? "",
      mainText: p.displayName?.text ?? "",
      secondaryText: p.formattedAddress ?? "",
      status: "not_in_mesita",
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
      openNow: p.currentOpeningHours?.openNow ?? null,
    }))
    .filter((p) => p.placeId && p.mainText)
    // Open-now first (demote, don't drop closed spots), then by rating.
    .sort((a, b) =>
      openScore(b.openNow) - openScore(a.openNow) ||
      (b.rating ?? 0) - (a.rating ?? 0)
    );
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

// ── Fallback prose (Perplexity unavailable) ────────────────────────────

function fallbackAnswer(
  query: string,
  onMesita: number,
  fromGoogle: number,
  placeSeeking: boolean,
): string {
  // Non-place question and no prose → generic recovery (don't promise spots).
  if (!placeSeeking) {
    return `My brain hiccuped for a second — ask me again in a moment and I'll give you a proper answer.`;
  }
  if (onMesita === 0 && fromGoogle === 0) {
    return `I couldn't pull spots for “${query}” right now — try a place name, a dish, or a neighborhood.`;
  }
  const parts: string[] = [];
  if (onMesita > 0) parts.push(`${onMesita} on Mesita`);
  if (fromGoogle > 0) parts.push(`${fromGoogle} from Google`);
  return `Here's what I'd check out for “${query}” — ${parts.join(" and ")}. Tap a Google spot's Add and I'll build its Mesita profile.`;
}
