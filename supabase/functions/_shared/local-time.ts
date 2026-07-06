// Local-time + open-now helpers shared by the consumer recommenders.
//
// The Edge runtime clock is UTC. Deriving a daypart or an "is it open" signal
// from UTC is wrong for our users: at 5am in Mexico (UTC−6) `getUTCHours()`
// reads ~11am and the recommender pitches brunch. This module gives the
// recommenders the user's LOCAL wall-clock and a live open/closed signal
// computed from the stored weekly hours — the same "when" fix consumer-web-
// ask-memo shipped in PR #211, extracted here so the swipe and map rankers
// share one implementation instead of each re-deriving it.
//
// Timezone is a coarse Mexico-centric mapping by longitude (the market). We do
// NOT read the DB `timezone` column here on purpose — memo established the
// lng-band approach and Intl handles DST; keeping one derivation avoids drift.

// Weekly hours shape stored on `places.hours` (JSONB), normalised from Google
// regularOpeningHours (migrations 0008 + 20252120001). Lowercase English day
// keys; multiple ranges per day cover same-day split shifts (lunch + dinner);
// an overnight shift is a single range on the opening day where `close <= open`
// means the close lands the next day; closed days omit the key.
export type HourRange = { open: string; close: string };
export type WeeklyHours = Record<string, HourRange[]>;

const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

// Coarse Mexico-centric timezone by longitude. Intl handles DST. Falls back to
// Central (Monterrey/CDMX — most of Mexico, and the safest default when we have
// no location). Mirrors consumer-web-ask-memo's `mexicoZone` (PR #211).
export function mexicoZone(lng: number | null): string {
  if (lng === null) return "America/Mexico_City";
  if (lng <= -110) return "America/Tijuana"; // Baja California / far NW (Pacific)
  if (lng >= -89) return "America/Cancun"; // Quintana Roo (UTC−5, no DST)
  return "America/Mexico_City"; // Central — Monterrey, CDMX, most of Mexico
}

// The user's LOCAL wall-clock derived from their longitude, not the UTC Edge
// runtime clock. Returns null on a bad zone so callers keep a neutral default.
export function localClock(
  lng: number | null,
): { weekday: string; hour: number; minutes: number } | null {
  const timeZone = mexicoZone(lng);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    let weekday = "";
    let hour = 12;
    let minute = 0;
    for (const p of parts) {
      if (p.type === "weekday") weekday = p.value.toLowerCase();
      else if (p.type === "hour") hour = parseInt(p.value, 10) % 24; // "24" at midnight → 0
      else if (p.type === "minute") minute = parseInt(p.value, 10);
    }
    if (!weekday) return null;
    return { weekday, hour, minutes: hour * 60 + minute };
  } catch {
    // Bad zone → let the caller fall back to a neutral default; never throw.
    return null;
  }
}

// Local hour 0–23 for the daypart handle. Defaults to midday on a bad zone so a
// time-of-day flavour never sinks the ranking.
export function localHour(lng: number | null): number {
  return localClock(lng)?.hour ?? 12;
}

function toMinutes(hhmm: unknown): number | null {
  if (typeof hhmm !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

// Pure open/closed check at a given local weekday + minute-of-day. Split out
// from isOpenNow so the overnight logic is deterministically testable (no
// wall-clock). `weekday` is a lowercase English day key; `nowMin` is 0–1439.
//   true  — a range covers nowMin (incl. overnight spillover from yesterday)
//   false — hours exist but nothing is open at that minute
//   null  — no usable hours data (caller treats as neutral, never penalised)
export function isOpenAt(
  hours: unknown,
  weekday: string,
  nowMin: number,
): boolean | null {
  if (!hours || typeof hours !== "object") return null;
  const week = hours as WeeklyHours;
  // "Has usable data" = at least one day carries a real range. All-empty (or
  // absent) → null so the place stays neutral rather than looking closed.
  if (!DAY_KEYS.some((k) => Array.isArray(week[k]) && week[k].length > 0)) {
    return null;
  }
  const todayIdx = DAY_KEYS.indexOf(weekday as (typeof DAY_KEYS)[number]);
  if (todayIdx < 0) return null;
  const today = DAY_KEYS[todayIdx];
  const yesterday = DAY_KEYS[(todayIdx + 6) % 7];

  // Today's ranges: same-day (open < close) covers [open, close); overnight
  // (close <= open) is open from `open` through the end of the day.
  for (const r of week[today] ?? []) {
    const o = toMinutes(r?.open);
    const c = toMinutes(r?.close);
    if (o === null || c === null) continue;
    if (o < c) {
      if (nowMin >= o && nowMin < c) return true;
    } else if (nowMin >= o) {
      return true;
    }
  }
  // Yesterday's overnight shift spills into today's [midnight, close).
  for (const r of week[yesterday] ?? []) {
    const o = toMinutes(r?.open);
    const c = toMinutes(r?.close);
    if (o === null || c === null) continue;
    if (c <= o && nowMin < c) return true;
  }
  return false;
}

// Live open/closed state computed from stored weekly hours against the place's
// LOCAL time (derived from lng). Returns null on no hours data or an
// unresolvable zone so the caller stays neutral. See isOpenAt for the rules.
export function isOpenNow(hours: unknown, lng: number | null): boolean | null {
  if (!hours || typeof hours !== "object") return null;
  const clock = localClock(lng);
  if (!clock) return null;
  return isOpenAt(hours, clock.weekday, clock.minutes);
}

// Rank weight for a place's live open state: open first, unknown neutral,
// closed last — the "demote, don't hide" ordering shared with Memo.
export function openScore(openNow: boolean | null | undefined): number {
  if (openNow === true) return 1;
  if (openNow === false) return -1;
  return 0; // unknown (no hours data) — neutral, never penalised
}

// Stable partition that floats open places above unknown above closed while
// preserving each caller's incoming order (relevance / partner-first) inside a
// bucket. `hoursOf` / `lngOf` read each row so a multi-city pool is judged in
// each place's own local time. "Demote, don't hide" — closed rows still appear,
// just after everything open.
export function demoteClosed<T>(
  rows: T[],
  hoursOf: (row: T) => unknown,
  lngOf: (row: T) => number | null,
): T[] {
  return rows
    .map((row, i) => ({ row, i, s: openScore(isOpenNow(hoursOf(row), lngOf(row))) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.row);
}
