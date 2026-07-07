import { assert, assertEquals } from "jsr:@std/assert";
import { resolveChannels, validateFieldUrl } from "./enrich-channel-discovery.ts";

// Zero candidate counts — irrelevant to the no-network paths below (they return
// before any Firecrawl/Perplexity call), but the field is required.
const NO_COUNTS = {
  website_url: 0,
  instagram_url: 0,
  facebook_url: 0,
  opentable_url: 0,
  uber_eats_url: 0,
};

// validateFieldUrl is the single host+shape gate every candidate passes through
// (footer link, Perplexity answer, citation, degraded search) before it's trusted.

Deno.test("tiktok: accepts /@handle profile, rejects a single video", () => {
  assert(validateFieldUrl("tiktok_url", "https://www.tiktok.com/@pujol"));
  assertEquals(validateFieldUrl("tiktok_url", "https://www.tiktok.com/@pujol/video/123"), null);
});

Deno.test("tripadvisor: accepts detail (-d…) page, rejects a city list", () => {
  assert(
    validateFieldUrl(
      "tripadvisor_url",
      "https://www.tripadvisor.com/Restaurant_Review-g150800-d1234567-Reviews-Pujol-Mexico_City.html",
    ),
  );
  assertEquals(
    validateFieldUrl("tripadvisor_url", "https://www.tripadvisor.com/Restaurants-g150800-Mexico_City.html"),
    null,
  );
});

Deno.test("yelp: accepts /biz/<slug>, rejects /search", () => {
  assert(validateFieldUrl("yelp_url", "https://www.yelp.com/biz/pujol-mexico-city"));
  assertEquals(validateFieldUrl("yelp_url", "https://www.yelp.com/search?find_desc=pujol"), null);
});

Deno.test("opentable: accepts /r/<slug>, rejects other paths", () => {
  assert(validateFieldUrl("opentable_url", "https://www.opentable.com/r/pujol-mexico-city"));
  assertEquals(validateFieldUrl("opentable_url", "https://www.opentable.com/pujol"), null);
});

Deno.test("ubereats: accepts /store/, rejects category page", () => {
  assert(validateFieldUrl("uber_eats_url", "https://www.ubereats.com/mx/store/pujol/abc123"));
  assertEquals(validateFieldUrl("uber_eats_url", "https://www.ubereats.com/mx/category/food"), null);
});

Deno.test("instagram: accepts profile, rejects a /p/ post", () => {
  assert(validateFieldUrl("instagram_url", "https://www.instagram.com/pujol"));
  assertEquals(validateFieldUrl("instagram_url", "https://www.instagram.com/p/Cabc123/"), null);
});

Deno.test("facebook: accepts a page, rejects a reserved path", () => {
  assert(validateFieldUrl("facebook_url", "https://www.facebook.com/pujolmx"));
  assertEquals(validateFieldUrl("facebook_url", "https://www.facebook.com/events/123456789"), null);
});

Deno.test("website: accepts a real site, rejects a social host", () => {
  assert(validateFieldUrl("website_url", "https://pujol.com.mx/menu"));
  assertEquals(validateFieldUrl("website_url", "https://www.instagram.com/pujol"), null);
});

Deno.test("wrong host for the field returns null", () => {
  assertEquals(
    validateFieldUrl("yelp_url", "https://www.tripadvisor.com/Restaurant_Review-d1234567-Reviews-Pujol.html"),
    null,
  );
  assertEquals(validateFieldUrl("tiktok_url", "https://www.instagram.com/pujol"), null);
});

// ── resolveChannels orchestration (no-network early-return paths) ────────────

const BASE = {
  name: "Pujol",
  city: "Mexico City",
  locationLine: "Mexico City",
  category: "restaurant",
  discoverCandidates: NO_COUNTS,
};

Deno.test("resolveChannels: fully seeded + no provider keys → freezes every field", async () => {
  const r = await resolveChannels({
    ...BASE,
    have: {
      website: "https://pujol.com.mx",
      instagram: "https://www.instagram.com/pujolrestaurant",
      facebook: "https://www.facebook.com/pujolmx",
      opentable: null,
      uberEats: null,
      phone: "+525554500000",
      email: "hola@pujol.com.mx",
    },
  });
  // Seeded channels are returned verbatim, tagged 'seed'.
  assertEquals(r.website_url, "https://pujol.com.mx");
  assertEquals(r.via.website_url, "seed");
  // Phone + email are now part of the same resolve contract (child B fold).
  assertEquals(r.phone, "+525554500000");
  assertEquals(r.email, "hola@pujol.com.mx");
  assertEquals(r.via.phone, "seed");
  assertEquals(r.via.email, "seed");
});

Deno.test("resolveChannels: missing fields but no keys → no fill, no network, missing stays null", async () => {
  const r = await resolveChannels({
    ...BASE,
    // both keys absent → the guard returns the seed unchanged before any call.
    have: {
      website: null,
      instagram: null,
      facebook: null,
      opentable: null,
      uberEats: null,
      phone: null,
      email: null,
    },
  });
  assertEquals(r.website_url, null);
  assertEquals(r.instagram_url, null);
  assertEquals(r.phone, null);
  assertEquals(r.email, null);
  // Nothing was resolved, so no provenance/via was recorded.
  assertEquals(Object.keys(r.via).length, 0);
  assertEquals(Object.keys(r.provenance).length, 0);
});

Deno.test("resolveChannels: a seeded phone is frozen even when a channel is missing (no keys)", async () => {
  const r = await resolveChannels({
    ...BASE,
    have: {
      website: "https://pujol.com.mx",
      instagram: null,
      facebook: null,
      opentable: null,
      uberEats: null,
      phone: "5215554500000",
      email: null,
    },
  });
  assertEquals(r.phone, "5215554500000");
  assertEquals(r.via.phone, "seed");
  assertEquals(r.website_url, "https://pujol.com.mx");
  assertEquals(r.via.website_url, "seed");
});
