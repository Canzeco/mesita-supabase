// Unit tests for Enricher tag selection (no network, no DB).
//   deno test supabase/functions/_shared/tags.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { sanitizePlaceTags, selectTopPlaceTags } from "./tags.ts";

Deno.test("sanitizePlaceTags: keeps first exclusive pole, drops the rest", () => {
  assertEquals(
    sanitizePlaceTags(["lively", "quiet", "casual", "upscale"]),
    ["lively", "casual"],
  );
  assertEquals(
    sanitizePlaceTags(["walk_ins_welcome", "reservations_required", "accepts_reservations"]),
    ["walk_ins_welcome"],
  );
});

Deno.test("sanitizePlaceTags: idempotent on clean lists", () => {
  const clean = ["lively", "cocktails", "full_bar", "trendy"];
  assertEquals(sanitizePlaceTags(clean), clean);
  assertEquals(sanitizePlaceTags(sanitizePlaceTags(clean)), clean);
});

Deno.test("selectTopPlaceTags: always returns exactly the requested count when enough candidates", () => {
  const ranked = Array.from({ length: 40 }, (_, i) => `tag_${i}`);
  const top = selectTopPlaceTags(ranked, 20);
  assertEquals(top.length, 20);
  assertEquals(top, ranked.slice(0, 20));
});

Deno.test("selectTopPlaceTags: never exceeds limit even with extras", () => {
  const ranked = Array.from({ length: 50 }, (_, i) => `tag_${i}`);
  assertEquals(selectTopPlaceTags(ranked, 20).length, 20);
  assertEquals(selectTopPlaceTags(ranked, 21).length, 21);
  assertEquals(selectTopPlaceTags(ranked, 19).length, 19);
});

Deno.test("selectTopPlaceTags: exclusive conflicts do not shrink below limit when fillers remain", () => {
  // lively blocks quiet; casual blocks upscale — both losers sit early so a naive
  // sanitize-then-hope would underfill if we stopped at the first 20 raw slugs.
  const ranked = [
    "lively",
    "quiet",
    "casual",
    "upscale",
    ...Array.from({ length: 30 }, (_, i) => `extra_${i}`),
  ];
  const top = selectTopPlaceTags(ranked, 20);
  assertEquals(top.length, 20);
  assertEquals(top[0], "lively");
  assertEquals(top[1], "casual");
  assertEquals(top.includes("quiet"), false);
  assertEquals(top.includes("upscale"), false);
  assertEquals(top[2], "extra_0");
});

Deno.test("selectTopPlaceTags: empty / zero limit", () => {
  assertEquals(selectTopPlaceTags([], 20), []);
  assertEquals(selectTopPlaceTags(["a", "b"], 0), []);
});
