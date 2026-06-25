// Atlas source — Firecrawl website: markdown (menu grounding) + website IMAGES.
// Crawl up to N pages (homepage + internal links), collect every <img> with its
// alt/dimensions/page context, then an LLM ranks them hero-first (square dims
// prioritised; logos/icons/sprites dropped). Social-layer.

import { firecrawlScrape } from "./firecrawl.ts";
import {
  extractImagesFromHtml,
  pickInternalPages,
  rankWebsiteImagesByRelevance,
  type WebImage,
} from "./atlas-image-funnel.ts";

export type WebsiteResult = {
  siteMarkdown: string;
  websiteImages: string[];
  websiteAssetMeta: Map<string, Record<string, unknown>>;
  diag: Record<string, unknown>;
};

export async function gatherWebsite(opts: {
  firecrawlKey: string;
  openaiKey: string | undefined;
  websiteUrl: string;
  websiteCrawlMaxPages: number;
  gatherWebsiteImages: number;
}): Promise<WebsiteResult> {
  const { firecrawlKey, openaiKey, websiteUrl, websiteCrawlMaxPages, gatherWebsiteImages } = opts;
  const websiteAssetMeta = new Map<string, Record<string, unknown>>();
  const fail: WebsiteResult = {
    siteMarkdown: "",
    websiteImages: [],
    websiteAssetMeta,
    diag: { ok: false },
  };
  try {
    const home = await firecrawlScrape(firecrawlKey, websiteUrl, {
      formats: ["markdown", "html", "links"],
      onlyMainContent: false,
    });
    if (!home) return fail;
    const siteMarkdown = home.markdown.slice(0, 6000);

    const candidates: WebImage[] = [];
    const seen = new Set<string>();
    const collect = (imgs: WebImage[]) => {
      for (const img of imgs) {
        if (!seen.has(img.url) && candidates.length < 60) {
          seen.add(img.url);
          candidates.push(img);
        }
      }
    };
    const og = home.metadata.ogImage;
    if (typeof og === "string") collect([{ url: og, alt: "og:image", page: "home" }]);
    collect(extractImagesFromHtml(home.html ?? "", websiteUrl, "home"));

    // Follow up to (N-1) same-domain internal pages, scraped in parallel.
    const extraPages = pickInternalPages(home.links, websiteUrl, websiteCrawlMaxPages - 1);
    if (extraPages.length > 0) {
      const scrapes = await Promise.all(
        extraPages.map((pg) =>
          firecrawlScrape(firecrawlKey, pg, { formats: ["html"], onlyMainContent: false }),
        ),
      );
      scrapes.forEach((s, i) => {
        if (s) collect(extractImagesFromHtml(s.html ?? "", extraPages[i], `p${i + 1}`));
      });
    }

    const ranked = await rankWebsiteImagesByRelevance(openaiKey, candidates);
    const websiteImages = ranked.slice(0, gatherWebsiteImages);
    for (const c of candidates) {
      websiteAssetMeta.set(c.url, {
        alt: c.alt || null,
        width: c.width ?? null,
        height: c.height ?? null,
        page: c.page,
      });
    }
    return {
      siteMarkdown,
      websiteImages,
      websiteAssetMeta,
      diag: {
        ok: !!siteMarkdown,
        pages: 1 + extraPages.length,
        candidates: candidates.length,
        images: websiteImages.length,
      },
    };
  } catch {
    return fail;
  }
}
