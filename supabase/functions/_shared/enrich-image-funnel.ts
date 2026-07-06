// Atlas place image funnel: HTML extraction, page picking, vision + text sort,
// and the gather→analyze→sort→save orchestration (runImageFunnel).

import { dedup, safeParseJson } from "./parse-utils.ts";
import type { Img } from "./enrich-config.ts";
import { OPENAI_URL, VISION_MODEL } from "./enrich-config.ts";

export type WebImage = {
  url: string;
  alt: string;
  width?: number;
  height?: number;
  page: string;
};

export function extractImagesFromHtml(
  html: string,
  baseUrl: string,
  page: string,
): WebImage[] {
  if (!html) return [];
  const out: WebImage[] = [];
  const seen = new Set<string>();
  const tagRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null && out.length < 40) {
    const tag = m[0];
    const srcRaw =
      /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ??
      /\bdata-src\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ??
      /\bsrcset\s*=\s*["']([^"',\s]+)/i.exec(tag)?.[1];
    if (!srcRaw) continue;
    let url: string;
    try {
      url = new URL(srcRaw.trim(), baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (/\.svg(\?|$)/i.test(url)) continue;
    if (seen.has(url)) continue;
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim() ?? "";
    let width = toInt(/\bwidth\s*=\s*["']?(\d+)/i.exec(tag)?.[1]);
    let height = toInt(/\bheight\s*=\s*["']?(\d+)/i.exec(tag)?.[1]);
    if (width == null || height == null) {
      const dim = /(\d{2,4})x(\d{2,4})/.exec(url);
      if (dim) {
        width = width ?? Number(dim[1]);
        height = height ?? Number(dim[2]);
      }
    }
    if (width != null && height != null && (width < 60 || height < 60)) continue;
    seen.add(url);
    out.push({ url, alt, width: width ?? undefined, height: height ?? undefined, page });
  }
  return out;
}

function toInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function pickInternalPages(
  links: string[],
  baseUrl: string,
  max: number,
): string[] {
  if (max <= 0) return [];
  let baseHost: string, basePath: string;
  try {
    const b = new URL(baseUrl);
    baseHost = b.hostname.replace(/^www\./, "");
    basePath = b.pathname.replace(/\/$/, "");
  } catch {
    return [];
  }
  const PRIORITY =
    /(galer|gallery|photo|foto|menu|carta|about|nosotros|space|salon|room|habitac|event|food|comida|drink|bar|restaurant)/i;
  const seen = new Set<string>();
  const scored: { url: string; score: number }[] = [];
  for (const raw of links) {
    let u: URL;
    try {
      u = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.hostname.replace(/^www\./, "") !== baseHost) continue;
    const path = u.pathname.replace(/\/$/, "");
    if (!path || path === basePath) continue;
    if (/\.(pdf|jpe?g|png|webp|gif|svg|zip|docx?|mp4)$/i.test(path)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ url: `${u.origin}${path}`, score: PRIORITY.test(path) ? 1 : 0 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.url);
}

export async function rankWebsiteImagesByRelevance(
  openaiKey: string | undefined,
  images: WebImage[],
): Promise<string[]> {
  if (images.length <= 1 || !openaiKey) return images.map((i) => i.url);
  const list = images
    .map((img, i) => {
      const file = img.url.split("/").pop()?.split("?")[0] ?? img.url;
      const dims = img.width && img.height ? `${img.width}x${img.height}` : "unknown";
      return `${i}: file="${file}" alt="${img.alt.slice(0, 80)}" dims=${dims} page=${img.page}`;
    })
    .join("\n");
  const user =
    `These are all the images found on a place's website (filename, alt text, ` +
    `dimensions, page). Rank them from MOST likely to be a hero / representative ` +
    `place photo (the space, interior, exterior, food, ambiance) to LEAST. ` +
    `PRIORITISE roughly SQUARE dimensions when known. ALWAYS rank LAST anything ` +
    `whose filename or alt contains logo / icon / favicon / badge / sprite / ` +
    `pixel / avatar, plus payment-method glyphs, social glyphs, and heavily ` +
    `text-laden banners.\n\n${list}\n\n` +
    `Return a SINGLE JSON object {"order": [indices best-to-worst]} including ` +
    `every index exactly once. No prose.`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r: Response;
    try {
      r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: VISION_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: user }],
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return images.map((i) => i.url);
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = (safeParseJson(data.choices?.[0]?.message?.content ?? "") as { order?: unknown })
      ?.order;
    if (!Array.isArray(raw)) return images.map((i) => i.url);
    const order: number[] = [];
    const seen = new Set<number>();
    for (const v of raw) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(n) && n >= 0 && n < images.length && !seen.has(n)) {
        order.push(n);
        seen.add(n);
      }
    }
    for (let i = 0; i < images.length; i++) if (!seen.has(i)) order.push(i);
    return order.map((i) => images[i].url);
  } catch {
    return images.map((i) => i.url);
  }
}

// Hosts whose signed/CDN links reject OpenAI's third-party image fetcher, so we
// must download the bytes inside the EF and inline them as a base64 data: URL.
// Extend this predicate as new blocking hosts surface.
const FETCHER_BLOCKED_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

function needsInlineImage(url: string): boolean {
  try {
    return FETCHER_BLOCKED_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024; // ~2 MB cap per image

// Download an image inside the EF and return it as a base64 data: URL. Returns
// null (caller falls back to the remote URL) on any failure, oversize body, or
// missing/non-image content. Shares the per-image AbortController so the 25 s
// timeout covers download + describe together.
//
// The 2 MB cap is enforced by STREAMING the body: we read chunk-by-chunk and
// bail (cancelling the reader) the moment the running total exceeds the cap, so
// an oversized body is never fully buffered. This matters because IG/FB signed
// CDN links use chunked transfer with NO content-length — the declared-length
// fast-path below can't see their size, and visionDescribe downloads a batch of
// these concurrently, so buffering whole oversized bodies could breach the
// ~256 MB Edge Function memory ceiling and OOM-kill the isolate (uncatchable —
// a try/catch could not then fall back to the remote URL). Exported for tests.
export async function fetchAsDataUrl(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    const contentType = r.headers.get("content-type") ?? "";
    if (!/^image\//i.test(contentType)) {
      await r.body?.cancel();
      return null;
    }
    // Fast-path early reject when the server declares an oversized length.
    const declared = Number(r.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_INLINE_IMAGE_BYTES) {
      await r.body?.cancel();
      return null;
    }
    if (!r.body) return null;

    // Stream the body with a hard byte ceiling, independent of content-length.
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > MAX_INLINE_IMAGE_BYTES) {
          // Oversized: stop reading, release the connection, fall back to URL.
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (total === 0) return null;

    // Concatenate the collected chunks and base64-encode (same style as before).
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let binary = "";
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    return `data:${contentType.split(";")[0]};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

export async function visionDescribe(
  openaiKey: string,
  urls: string[],
  prompt: string,
  model: string = VISION_MODEL,
): Promise<string[] | null> {
  const describeOne = async (url: string): Promise<string> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      let imageUrl = url;
      if (needsInlineImage(url)) {
        const dataUrl = await fetchAsDataUrl(url, ctrl.signal);
        if (dataUrl) imageUrl = dataUrl;
      }
      const r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
              ],
            },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!r.ok) return "";
      const data = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return (data.choices?.[0]?.message?.content ?? "").trim();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // Bound download+describe concurrency: each fetcher-blocked image is buffered
    // (base64 data: URL) before its describe call, so firing all ~20 at once would
    // stack peak memory. A small pool keeps transient memory low (defense in depth
    // alongside the streaming cap in fetchAsDataUrl).
    const descriptions = await mapPool(urls, 5, describeOne);
    if (descriptions.every((d) => !d)) return null;
    return descriptions;
  } catch {
    return null;
  }
}

// Run `fn` over `items` with at most `limit` in flight at once, preserving the
// input order in the returned array.
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(Math.max(1, limit), items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

export async function textSortImages(
  openaiKey: string,
  descriptions: string[],
  prompt: string,
): Promise<number[] | null> {
  const list = descriptions.map((d, i) => `${i}: ${d || "(no description)"}`).join("\n");
  const user =
    prompt +
    `\n\nImages (index: description):\n${list}\n\nReturn a SINGLE JSON object ` +
    `{"order": [indices best-to-worst]}. Include EVERY index exactly once; do ` +
    `not drop any. No prose, no fences.`;
  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: user }],
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const obj = safeParseJson(data.choices?.[0]?.message?.content ?? "");
    const raw = (obj as { order?: unknown })?.order;
    if (!Array.isArray(raw)) return null;
    const order: number[] = [];
    const seen = new Set<number>();
    for (const v of raw) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(n) && n >= 0 && n < descriptions.length && !seen.has(n)) {
        order.push(n);
        seen.add(n);
      }
    }
    for (let i = 0; i < descriptions.length; i++) {
      if (!seen.has(i)) order.push(i);
    }
    return order;
  } catch {
    return null;
  }
}

export type ImageFunnelResult = {
  // The gathered, de-duped, source-tagged pool (drives media-asset persistence).
  saved: Img[];
  // The ordered top-N URLs to persist as place.photos.
  finalPhotos: string[];
  // url → vision description (for the analyzed subset).
  imageAnalysisByUrl: Map<string, string>;
  diag: Record<string, unknown>;
};

// Pick the final photo set with a SOURCE-DIVERSITY floor: reserve up to
// reservePerSource of each non-Google source's best (in `ordered` order), then
// fill the remaining slots by overall order, capped at `cap`. Guarantees website
// + Instagram representation whenever those sources contributed images — the
// vision rubric otherwise tends to rank Google Places photos highest and crowd
// the others out (which is why places looked "Google-only").
function selectWithDiversity(
  ordered: string[],
  srcOf: Map<string, Img["source"]>,
  cap: number,
): string[] {
  const reservePerSource = Math.min(3, Math.max(1, Math.floor(cap / 4)));
  const picked: string[] = [];
  const seen = new Set<string>();
  const take = (u: string) => {
    if (u && !seen.has(u) && picked.length < cap) {
      seen.add(u);
      picked.push(u);
    }
  };
  for (const src of ["instagram", "website"] as const) {
    let n = 0;
    for (const u of ordered) {
      if (n >= reservePerSource) break;
      if (srcOf.get(u) === src && !seen.has(u)) {
        take(u);
        n += 1;
      }
    }
  }
  for (const u of ordered) take(u);
  return picked;
}

// Image funnel: build the gathered pool (each source contributes its gather-
// capped, metadata-sorted bucket), then ANALYZE (vision describes the per-source
// analyze-capped top of each bucket) → SORT (text model ranks the descriptions
// by the experience rubric) → SAVE the best N overall (source-independent).
// business-create-unit may have seeded Places photos into existingPhotos — fold
// those into the Google bucket so they're never lost, capped at the Google cap.
export async function runImageFunnel(opts: {
  googleImages: string[];
  websiteImages: string[];
  instagramImages: string[];
  existingPhotos: string[];
  gatherGoogleImages: number;
  saveTotalImages: number;
  photoCeiling: number;
  runVision: boolean;
  openaiKey: string | undefined;
  // Per-image describe model (admin "Image model" knob). Sort stays on the
  // cheap VISION_MODEL — matches the cost calculator.
  visionModel?: string;
  analyze: { google: number; website: number; instagram: number };
  imageAnalysisPrompt: string;
  imageSortingPrompt: string;
}): Promise<ImageFunnelResult> {
  const {
    googleImages,
    websiteImages,
    instagramImages,
    existingPhotos,
    gatherGoogleImages,
    saveTotalImages,
    photoCeiling,
    runVision,
    openaiKey,
    visionModel,
    analyze,
    imageAnalysisPrompt,
    imageSortingPrompt,
  } = opts;

  const googleBucket = dedup([...googleImages, ...existingPhotos]).slice(0, gatherGoogleImages);
  const saved: Img[] = [];
  const imageAnalysisByUrl = new Map<string, string>();
  const savedSeen = new Set<string>();
  const pushImg = (url: string, source: Img["source"]) => {
    if (!url || savedSeen.has(url) || saved.length >= photoCeiling) return;
    savedSeen.add(url);
    saved.push({ url, source });
  };
  for (const u of googleBucket) pushImg(u, "google");
  for (const u of websiteImages) pushImg(u, "website");
  for (const u of instagramImages) pushImg(u, "instagram");

  const srcOf = new Map<string, Img["source"]>(saved.map((s) => [s.url, s.source]));
  let finalPhotos = selectWithDiversity(saved.map((s) => s.url), srcOf, saveTotalImages);
  let diag: Record<string, unknown> = {
    gathered: saved.length,
    by_source: {
      google: saved.filter((s) => s.source === "google").length,
      website: saved.filter((s) => s.source === "website").length,
      instagram: saved.filter((s) => s.source === "instagram").length,
    },
    save_cap: saveTotalImages,
    vision: false,
  };

  if (runVision && openaiKey && saved.length > 1) {
    const caps: Record<Img["source"], number> = {
      google: analyze.google,
      website: analyze.website,
      instagram: analyze.instagram,
    };
    const used: Record<Img["source"], number> = { google: 0, website: 0, instagram: 0 };
    const toAnalyze: Img[] = [];
    for (const img of saved) {
      if (used[img.source] < caps[img.source]) {
        toAnalyze.push(img);
        used[img.source] += 1;
      }
    }
    if (toAnalyze.length > 0) {
      const descriptions = await visionDescribe(
        openaiKey,
        toAnalyze.map((i) => i.url),
        imageAnalysisPrompt,
        visionModel ?? VISION_MODEL,
      );
      let order: number[] | null = null;
      if (descriptions) {
        for (let i = 0; i < descriptions.length; i += 1) {
          const desc = descriptions[i];
          if (desc && toAnalyze[i]?.url) imageAnalysisByUrl.set(toAnalyze[i].url, desc);
        }
        order = await textSortImages(openaiKey, descriptions, imageSortingPrompt);
      }
      if (order && order.length > 0) {
        const ranked = order
          .filter((i) => i >= 0 && i < toAnalyze.length)
          .map((i) => toAnalyze[i].url);
        const analyzedSet = new Set(toAnalyze.map((i) => i.url));
        const rest = saved.map((s) => s.url).filter((u) => !analyzedSet.has(u));
        // Rubric-ranked images lead; un-analyzed gathered images follow in
        // metadata order. Then keep only the top N overall (source-independent).
        finalPhotos = selectWithDiversity(dedup([...ranked, ...rest]), srcOf, saveTotalImages);
        diag = {
          ...diag,
          vision: true,
          model: visionModel ?? VISION_MODEL,
          analyzed: toAnalyze.length,
          described: !!descriptions,
          sorted: true,
          saved: finalPhotos.length,
        };
      } else {
        diag = { ...diag, vision: true, analyzed: toAnalyze.length, sorted: false };
      }
    }
  }

  return { saved, finalPhotos, imageAnalysisByUrl, diag };
}
