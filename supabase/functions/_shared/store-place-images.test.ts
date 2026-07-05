import { assertEquals } from "jsr:@std/assert@1";
import {
  extFor,
  imageIdFromPath,
  isHttpUrl,
  type PlaceImageAssetInput,
  sanitiseAssets,
  sanitiseUrls,
} from "./store-place-images.ts";

Deno.test("sanitiseAssets dedupes and caps invalid rows", () => {
  const assets = sanitiseAssets([
    { source: "google", source_url: "https://a.example/1.jpg" },
    { source: "google", source_url: "https://a.example/1.jpg" },
    { source: "bad", source_url: "https://a.example/2.jpg" } as unknown as PlaceImageAssetInput,
    { source: "website", source_url: "data:image/png;base64,abc" },
    { source: "instagram", source_url: "https://a.example/3.jpg", likes_count: 12.7 },
  ]);
  assertEquals(assets.length, 2);
  assertEquals(assets[0].source_url, "https://a.example/1.jpg");
  assertEquals(assets[1].likes_count, 12);
});

Deno.test("sanitiseUrls keeps http(s) only", () => {
  assertEquals(
    sanitiseUrls([" https://x.test/a ", "ftp://x.test/b", "https://x.test/a"]),
    ["https://x.test/a"],
  );
});

Deno.test("isHttpUrl rejects non-http schemes", () => {
  assertEquals(isHttpUrl("https://ok.test/x"), true);
  assertEquals(isHttpUrl("data:image/png;base64,abc"), false);
});

Deno.test("extFor maps common image types", () => {
  assertEquals(extFor("image/png"), "png");
  assertEquals(extFor("image/jpeg"), "jpg");
});

Deno.test("imageIdFromPath extracts sha256 stem", () => {
  const id = "a".repeat(64);
  assertEquals(imageIdFromPath(`images/${id}.webp`), id);
  assertEquals(imageIdFromPath("images/not-a-hash.jpg"), null);
});
