import { assert, assertEquals } from "jsr:@std/assert";
import { validateFieldUrl } from "./atlas-channel-discovery.ts";

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
