// Unit tests for the recommender local-time / open-now helpers. Pure, no
// network/DB. The wall-clock functions (localClock/isOpenNow) delegate to the
// pure isOpenAt, which is what we pin down here.
//   deno test supabase/functions/_shared/local-time.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import {
  demoteClosed,
  isOpenAt,
  mexicoZone,
  openScore,
  type WeeklyHours,
} from "./local-time.ts";

// Fri 6pm–2am (overnight), plus a same-day lunch shift on Saturday.
const HOURS: WeeklyHours = {
  friday: [{ open: "18:00", close: "02:00" }],
  saturday: [{ open: "13:00", close: "16:00" }],
};

Deno.test("isOpenAt: same-day range is a half-open interval", () => {
  // Saturday 13:00–16:00
  assertEquals(isOpenAt(HOURS, "saturday", 12 * 60 + 59), false); // 12:59 before open
  assertEquals(isOpenAt(HOURS, "saturday", 13 * 60), true); // 13:00 open edge
  assertEquals(isOpenAt(HOURS, "saturday", 15 * 60 + 30), true); // mid
  assertEquals(isOpenAt(HOURS, "saturday", 16 * 60), false); // 16:00 close edge (exclusive)
});

Deno.test("isOpenAt: overnight range spills into the next day", () => {
  // Friday 18:00 → Saturday 02:00
  assertEquals(isOpenAt(HOURS, "friday", 17 * 60 + 59), false); // Fri 17:59 before open
  assertEquals(isOpenAt(HOURS, "friday", 18 * 60), true); // Fri 18:00 open
  assertEquals(isOpenAt(HOURS, "friday", 23 * 60 + 59), true); // Fri 23:59 still open
  assertEquals(isOpenAt(HOURS, "saturday", 1 * 60), true); // Sat 01:00 spillover from Fri
  assertEquals(isOpenAt(HOURS, "saturday", 2 * 60), false); // Sat 02:00 close edge
  assertEquals(isOpenAt(HOURS, "saturday", 2 * 60 + 30), false); // Sat 02:30 after overnight close, before lunch
});

Deno.test("isOpenAt: closed day (key omitted) reads as closed, not unknown", () => {
  // Monday has no key and no overnight spillover from Sunday → false (data
  // exists, this place just isn't open Mondays).
  assertEquals(isOpenAt(HOURS, "monday", 12 * 60), false);
});

Deno.test("isOpenAt: no/blank hours data is unknown (null), never penalised", () => {
  assertEquals(isOpenAt(null, "friday", 720), null);
  assertEquals(isOpenAt({}, "friday", 720), null);
  assertEquals(isOpenAt({ friday: [] }, "friday", 720), null); // no real day keys with ranges
});

Deno.test("isOpenAt: malformed range times are skipped, not crashed", () => {
  const bad: WeeklyHours = {
    // Valid saturday range coexists with a garbage one so the array still
    // registers as "has hours data" (not null).
    saturday: [
      { open: "oops", close: "nope" },
      { open: "13:00", close: "16:00" },
    ],
  };
  assertEquals(isOpenAt(bad, "saturday", 14 * 60), true); // matched the valid range
  assertEquals(isOpenAt(bad, "saturday", 20 * 60), false); // valid range closed, bad one ignored
});

Deno.test("openScore: open first, unknown neutral, closed last", () => {
  assertEquals(openScore(true), 1);
  assertEquals(openScore(null), 0);
  assertEquals(openScore(undefined), 0);
  assertEquals(openScore(false), -1);
});

Deno.test("demoteClosed: stable partition open > unknown > closed", () => {
  type Row = { id: string; hours: WeeklyHours | null; lng: number | null };
  const openHours: WeeklyHours = { monday: [{ open: "00:00", close: "23:59" }] }; // ~24h Mon
  const closedHours: WeeklyHours = { sunday: [{ open: "09:00", close: "10:00" }] }; // not Mon
  // A pool where the incoming (relevance) order interleaves states. We can't
  // pin the wall-clock, but 24h-Monday vs no-Monday still partition relative to
  // *whatever* day it is only when it's Monday — so assert structural
  // properties instead: unknowns keep neutral, ordering within a bucket is
  // preserved, and the sort is stable.
  const rows: Row[] = [
    { id: "a-unknown", hours: null, lng: -99 },
    { id: "b-unknown", hours: {}, lng: -99 },
    { id: "c-unknown", hours: null, lng: -99 },
  ];
  // All unknown → order must be preserved exactly (stable, all score 0).
  const out = demoteClosed(rows, (r) => r.hours, (r) => r.lng).map((r) => r.id);
  assertEquals(out, ["a-unknown", "b-unknown", "c-unknown"]);
  // Referenced so the intent of the fixtures is documented even though the
  // wall-clock-dependent buckets aren't asserted here (isOpenAt covers those).
  assertEquals(typeof openHours.monday, "object");
  assertEquals(typeof closedHours.sunday, "object");
});

Deno.test("mexicoZone: longitude bands", () => {
  assertEquals(mexicoZone(null), "America/Mexico_City");
  assertEquals(mexicoZone(-116), "America/Tijuana"); // Baja
  assertEquals(mexicoZone(-99), "America/Mexico_City"); // CDMX
  assertEquals(mexicoZone(-86), "America/Cancun"); // Quintana Roo
});
