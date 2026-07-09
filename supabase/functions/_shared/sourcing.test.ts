import { assertEquals } from "jsr:@std/assert";
import {
  autocompleteTypesForPolicy,
  coerceChannelPolicy,
  evaluatePlaceForChannel,
  familyForGoogleType,
} from "./sourcing.ts";

Deno.test("familyForGoogleType maps known types", () => {
  assertEquals(familyForGoogleType("mexican_restaurant"), "restaurants");
  assertEquals(familyForGoogleType("night_club"), "bars_nightlife");
  assertEquals(familyForGoogleType("gas_station"), null);
});

Deno.test("evaluatePlaceForChannel rejects ineligible family", () => {
  const policy = coerceChannelPolicy(
    { enabled: true, families: ["restaurants"], minRating: 0, minReviews: 0 },
    "consumer_add",
  );
  const verdict = evaluatePlaceForChannel(policy, {
    primaryType: "night_club",
    rating: 4.5,
    reviewCount: 200,
  });
  assertEquals(verdict.eligible, false);
  if (!verdict.eligible) assertEquals(verdict.code, "family_not_eligible");
});

Deno.test("evaluatePlaceForChannel rejects below rating floor", () => {
  const policy = coerceChannelPolicy(null, "consumer_add");
  const verdict = evaluatePlaceForChannel(policy, {
    primaryType: "restaurant",
    rating: 3.0,
    reviewCount: 200,
  });
  assertEquals(verdict.eligible, false);
  if (!verdict.eligible) assertEquals(verdict.code, "below_min_rating");
});

Deno.test("evaluatePlaceForChannel rejects below review floor", () => {
  const policy = coerceChannelPolicy(null, "consumer_add");
  const verdict = evaluatePlaceForChannel(policy, {
    primaryType: "restaurant",
    rating: 4.5,
    reviewCount: 50,
  });
  assertEquals(verdict.eligible, false);
  if (!verdict.eligible) assertEquals(verdict.code, "below_min_reviews");
});

Deno.test("evaluatePlaceForChannel accepts qualifying place", () => {
  const policy = coerceChannelPolicy(null, "consumer_add");
  const verdict = evaluatePlaceForChannel(policy, {
    primaryType: "restaurant",
    rating: 4.5,
    reviewCount: 150,
  });
  assertEquals(verdict, { eligible: true });
});

Deno.test("autocompleteTypesForPolicy returns up to 5 family types", () => {
  const types = autocompleteTypesForPolicy(
    coerceChannelPolicy(null, "consumer_search"),
  );
  assertEquals(types.length, 5);
  assertEquals(types.includes("restaurant"), true);
});

Deno.test("autocompleteTypesForPolicy empty when no families", () => {
  const types = autocompleteTypesForPolicy({
    enabled: true,
    families: [],
    minRating: 0,
    minReviews: 0,
  });
  assertEquals(types, []);
});
