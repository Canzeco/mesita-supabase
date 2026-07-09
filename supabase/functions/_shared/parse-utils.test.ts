import { assertEquals } from "jsr:@std/assert";
import { safeParseJson } from "./parse-utils.ts";

Deno.test("safeParseJson: plain object", () => {
  assertEquals(safeParseJson('{"a":1}'), { a: 1 });
});

Deno.test("safeParseJson: markdown fence", () => {
  assertEquals(safeParseJson('```json\n{"a":1}\n```'), { a: 1 });
});

Deno.test("safeParseJson: leading prose", () => {
  assertEquals(safeParseJson('Here you go:\n{"website_url":null,"instagram_url":"https://instagram.com/x"}'), {
    website_url: null,
    instagram_url: "https://instagram.com/x",
  });
});

Deno.test("safeParseJson: trailing comma (Sonar under load)", () => {
  assertEquals(safeParseJson('{"website_url":null,"instagram_url":null,}'), {
    website_url: null,
    instagram_url: null,
  });
});

Deno.test("safeParseJson: truncated closing brace", () => {
  assertEquals(safeParseJson('{"website_url":null,"instagram_url":null'), {
    website_url: null,
    instagram_url: null,
  });
});

Deno.test("safeParseJson: empty / garbage → null", () => {
  assertEquals(safeParseJson(""), null);
  assertEquals(safeParseJson("not json"), null);
});
