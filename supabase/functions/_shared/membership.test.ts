// Unit tests for the promo-rate resolver (MESITA-142). Pure, no network/DB.
//   deno test supabase/functions/_shared/membership.test.ts
//
// selectprojectRate maps (place rates, consumer class, first-visit?) -> the
// integer percent used by the discount math. It must return ONLY the final
// percent (the "blended rate" privacy invariant) and fall back gracefully when
// a rate column is null.

import { assertEquals } from "jsr:@std/assert@1";
import { selectprojectRate, type PlaceRates } from "./membership.ts";

const RATES: PlaceRates = {
  welcome_free_rate: 5,
  welcome_premium_rate: 15,
  free_rate: 10,
  premium_rate: 20,
};

Deno.test("selectprojectRate: premium vs free on a return visit", () => {
  assertEquals(selectprojectRate(RATES, "premium", false), 20);
  assertEquals(selectprojectRate(RATES, "free", false), 10);
  assertEquals(selectprojectRate(RATES, null, false), 10);
});

Deno.test("selectprojectRate: first-visit uses the welcome columns", () => {
  assertEquals(selectprojectRate(RATES, "premium", true), 15);
  assertEquals(selectprojectRate(RATES, "free", true), 5);
});

Deno.test("selectprojectRate: premium falls back to free column when premium is null", () => {
  const rates: PlaceRates = {
    welcome_free_rate: 5,
    welcome_premium_rate: null,
    free_rate: 10,
    premium_rate: null,
  };
  assertEquals(selectprojectRate(rates, "premium", false), 10); // -> free_rate
  assertEquals(selectprojectRate(rates, "premium", true), 5); // -> welcome_free_rate
});

Deno.test("selectprojectRate: all-null rates resolve to 0, never negative", () => {
  const rates: PlaceRates = {
    welcome_free_rate: null,
    welcome_premium_rate: null,
    free_rate: null,
    premium_rate: null,
  };
  assertEquals(selectprojectRate(rates, "premium", false), 0);
  assertEquals(selectprojectRate(rates, "free", true), 0);
});

Deno.test("selectprojectRate: clamps out-of-range rates into 0..100", () => {
  assertEquals(selectprojectRate({ ...RATES, free_rate: 150 }, "free", false), 100);
  assertEquals(selectprojectRate({ ...RATES, free_rate: -5 }, "free", false), 0);
});
