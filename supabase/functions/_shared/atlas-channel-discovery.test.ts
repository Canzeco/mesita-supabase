import { assertEquals } from "jsr:@std/assert";
import { passesNameGate } from "./atlas-channel-discovery.ts";

const ctx = {
  nameTokens: ["pujol", "restaurant"],
  cityTokens: ["mexico", "city"],
};

Deno.test("passesNameGate: website_footer links skip name gate", () => {
  const ok = passesNameGate("facebook", {
    url: "https://www.facebook.com/randomhandle",
    field: "facebook",
    provider: "website_footer",
    source: "website_footer",
  }, ctx);
  assertEquals(ok, true);
});

Deno.test("passesNameGate: perplexity facebook requires name token in path", () => {
  const bad = passesNameGate("facebook", {
    url: "https://www.facebook.com/totallyunrelated",
    field: "facebook",
    provider: "perplexity",
    source: "json_or_citations",
  }, ctx);
  const good = passesNameGate("facebook", {
    url: "https://www.facebook.com/pujolmx",
    field: "facebook",
    provider: "perplexity",
    source: "json_or_citations",
  }, ctx);
  assertEquals(bad, false);
  assertEquals(good, true);
});

Deno.test("passesNameGate: opentable requires venue name in slug", () => {
  const bad = passesNameGate("opentable", {
    url: "https://www.opentable.com/r/generic-restaurants-mexico-city",
    field: "opentable",
    provider: "firecrawl",
    source: "search",
  }, ctx);
  const good = passesNameGate("opentable", {
    url: "https://www.opentable.com/r/pujol-mexico-city",
    field: "opentable",
    provider: "firecrawl",
    source: "search",
  }, ctx);
  assertEquals(bad, false);
  assertEquals(good, true);
});

Deno.test("passesNameGate: ubereats requires name token in store slug", () => {
  const bad = passesNameGate("ubereats", {
    url: "https://www.ubereats.com/mx/store/monterrey-delivery/abc",
    field: "ubereats",
    provider: "firecrawl",
    source: "search",
  }, ctx);
  const good = passesNameGate("ubereats", {
    url: "https://www.ubereats.com/mx/store/pujol-polanco/abc",
    field: "ubereats",
    provider: "firecrawl",
    source: "search",
  }, ctx);
  assertEquals(bad, false);
  assertEquals(good, true);
});
