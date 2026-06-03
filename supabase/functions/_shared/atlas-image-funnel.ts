// Atlas venue image funnel: HTML extraction, page picking, vision + text sort.

import { safeParseJson } from "./parse-utils.ts";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const VISION_MODEL = "gpt-4o-mini";

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
