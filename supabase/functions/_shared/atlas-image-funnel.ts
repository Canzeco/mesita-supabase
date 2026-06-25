// Atlas venue image funnel: HTML extraction, page picking, vision + text sort,
// and the gather→analyze→sort→save orchestration (runImageFunnel).

import { dedup, safeParseJson } from "./parse-utils.ts";
import type { Img } from "./atlas-config.ts";
import { OPENAI_URL, VISION_MODEL } from "./atlas-config.ts";

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
    `These are all the images found on a venue's website (filename, alt text, ` +
    `dimensions, page). Rank them from MOST likely to be a hero / representative ` +
    `venue photo (the space, interior, exterior, food, ambiance) to LEAST. ` +
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

export async function visionDescribe(
  openaiKey: string,
  urls: string[],
  prompt: string,
): Promise<string[] | null> {
  const describeOne = async (url: string): Promise<string> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
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
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url, detail: "low" } },
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
    const descriptions = await Promise.all(urls.map((u) => describeOne(u)));
    if (descriptions.every((d) => !d)) return null;
    return descriptions;
  } catch {
    return null;
  }
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
  // The ordered top-N URLs to persist as venue.photos.
  finalPhotos: string[];
  // url → vision description (for the analyzed subset).
  imageAnalysisByUrl: Map<string, string>;
  diag: Record<string, unknown>;
};

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

  let finalPhotos = saved.map((s) => s.url).slice(0, saveTotalImages);
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
        finalPhotos = dedup([...ranked, ...rest]).slice(0, saveTotalImages);
        diag = {
          ...diag,
          vision: true,
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
