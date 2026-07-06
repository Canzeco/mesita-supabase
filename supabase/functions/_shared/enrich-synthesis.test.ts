// Unit tests for the synthesis output guards (no network, no DB).
//   deno test supabase/functions/_shared/enrich-synthesis.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { applyProfileToUpdate, asProfileText, type ProfileResult } from "./enrich-synthesis.ts";

Deno.test("asProfileText: trims strings, joins arrays and string-valued objects, drops the rest", () => {
  assertEquals(asProfileText("  hola  "), "hola");
  assertEquals(asProfileText(["Para uno.", " Para dos. "]), "Para uno.\n\nPara dos.");
  // gpt-4o-mini emits object-shaped Abouts under thin grounding — flatten them.
  assertEquals(
    asProfileText({ intro: "Un lugar.", ambiente: "Cálido." }),
    "Un lugar.\n\nCálido.",
  );
  assertEquals(asProfileText([{ paragraph: "objeto" }, "y texto"]), "objeto\n\ny texto");
  assertEquals(asProfileText({ n: 42 }), null);
  assertEquals(asProfileText(42), null);
  assertEquals(asProfileText(null), null);
  assertEquals(asProfileText([]), null);
  assertEquals(asProfileText("   "), null);
});

Deno.test("applyProfileToUpdate: off-type LLM fields never throw — dropped or coerced", () => {
  const update: Record<string, unknown> = {};
  // The MESITA-122 crash shape: json_object mode returned non-string fields.
  const parsed = {
    description: [{ paragraph: "objeto" }],
    zone: 7,
    city: null,
    established_year: "1998",
    executive_chef: ["Ana", " Luis "],
    editorial_summary: { text: "x" },
    details: ["not-an-object"],
    products: { menu: [] },
    popular_times: "busy",
  } as unknown as ProfileResult;
  applyProfileToUpdate(update, parsed);
  assertEquals(update.description, "objeto");
  assertEquals("zone" in update, false);
  assertEquals("city" in update, false);
  assertEquals(update.established_year, 1998);
  assertEquals(update.executive_chef, "Ana\n\nLuis");
  assertEquals(update.editorial_summary, "x");
  assertEquals("details" in update, false);
  assertEquals("products" in update, false);
  assertEquals("popular_times" in update, false);
});

Deno.test("applyProfileToUpdate: a paragraph ARRAY description is joined, not crashed on", () => {
  const update: Record<string, unknown> = {};
  applyProfileToUpdate(update, {
    description: ["Primer párrafo.", "Segundo párrafo."],
  } as unknown as ProfileResult);
  assertEquals(update.description, "Primer párrafo.\n\nSegundo párrafo.");
});

Deno.test("applyProfileToUpdate: happy path unchanged (trimmed, capped, typed)", () => {
  const update: Record<string, unknown> = {};
  applyProfileToUpdate(update, {
    description: "  Un lugar con historia.  ",
    zone: "San Pedro",
    established_year: 2012,
    details: { dress_code: "casual" },
    popular_times: [{ day: "Fri", range: "8-11pm" }],
  } as ProfileResult);
  assertEquals(update.description, "Un lugar con historia.");
  assertEquals(update.zone, "San Pedro");
  assertEquals(update.established_year, 2012);
  assertEquals(update.details, { dress_code: "casual" });
  assertEquals(update.popular_times, [{ day: "Fri", range: "8-11pm" }]);
});
