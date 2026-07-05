// Unit tests for the image funnel's pure helpers (no network, no DB).
//   deno test supabase/functions/_shared/enrich-image-funnel.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { extractImagesFromHtml, pickInternalPages } from "./enrich-image-funnel.ts";

const BASE = "https://example.com";

Deno.test("extractImagesFromHtml: src, data-src, and srcset are all read", () => {
  const html = `
    <img src="/a.jpg" alt="hero">
    <img data-src="https://cdn.example.com/b.png">
    <img srcset="/c-400.webp 400w, /c-800.webp 800w">`;
  const out = extractImagesFromHtml(html, BASE, "home");
  assertEquals(out.map((i) => i.url), [
    "https://example.com/a.jpg",
    "https://cdn.example.com/b.png",
    "https://example.com/c-400.webp",
  ]);
  assertEquals(out[0].alt, "hero");
  assertEquals(out[0].page, "home");
});

Deno.test("extractImagesFromHtml: drops SVGs, tiny images, dupes, and non-http schemes", () => {
  const html = `
    <img src="/logo.svg">
    <img src="/pixel.png" width="1" height="1">
    <img src="/keep.jpg" width="800" height="600">
    <img src="/keep.jpg">
    <img src="data:image/gif;base64,R0lGOD">`;
  const out = extractImagesFromHtml(html, BASE, "home");
  assertEquals(out.map((i) => i.url), ["https://example.com/keep.jpg"]);
  assertEquals(out[0].width, 800);
});

Deno.test("extractImagesFromHtml: infers dimensions from the URL when attributes are absent", () => {
  const html = `<img src="/gallery/photo-1200x800.jpg">`;
  const out = extractImagesFromHtml(html, BASE, "p1");
  assertEquals(out[0].width, 1200);
  assertEquals(out[0].height, 800);
});

Deno.test("pickInternalPages: same-host pages only, priority paths first, capped", () => {
  const links = [
    "https://example.com/menu",          // priority
    "https://example.com/contact",       // plain
    "https://example.com/galeria",       // priority (es)
    "https://other.com/menu",            // wrong host
    "https://example.com/brochure.pdf",  // asset
    "https://example.com/",              // the base itself
    "/about",                            // relative, priority
  ];
  const out = pickInternalPages(links, BASE, 3);
  assertEquals(out, [
    "https://example.com/menu",
    "https://example.com/galeria",
    "https://example.com/about",
  ]);
});

Deno.test("pickInternalPages: dedupes by path and respects max<=0", () => {
  const links = [
    "https://example.com/menu",
    "https://example.com/menu/",
    "https://example.com/MENU",
  ];
  assertEquals(pickInternalPages(links, BASE, 5).length, 1);
  assertEquals(pickInternalPages(links, BASE, 0), []);
});
