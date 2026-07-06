// Unit tests for the cent-amount parser (MESITA-142). Pure, no network/DB.
//   deno test supabase/functions/_shared/money.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { toCents } from "./money.ts";

Deno.test("toCents: accepts non-negative integers unchanged", () => {
  assertEquals(toCents(0), 0);
  assertEquals(toCents(1), 1);
  assertEquals(toCents(85000), 85000);
});

Deno.test("toCents: parses numeric strings from JSON/form input", () => {
  assertEquals(toCents("0"), 0);
  assertEquals(toCents("85000"), 85000);
});

Deno.test("toCents: truncates fractional cents toward zero (never rounds up money)", () => {
  assertEquals(toCents(99.9), 99);
  assertEquals(toCents("99.9"), 99);
  assertEquals(toCents(0.5), 0);
});

Deno.test("toCents: rejects negatives — no negative charge can be minted", () => {
  assertEquals(toCents(-1), null);
  assertEquals(toCents("-1"), null);
  assertEquals(toCents(-0.01), null);
});

Deno.test("toCents: rejects null/undefined/non-numeric/NaN/Infinity", () => {
  assertEquals(toCents(null), null);
  assertEquals(toCents(undefined), null);
  assertEquals(toCents("abc"), null);
  assertEquals(toCents(""), 0); // Number("") === 0 — documents current behavior
  assertEquals(toCents(NaN), null);
  assertEquals(toCents(Infinity), null);
  assertEquals(toCents({}), null);
});
