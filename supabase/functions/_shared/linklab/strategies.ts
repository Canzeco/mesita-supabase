// linklab — the 5 link-discovery strategies under test.
// Each: (ctx, keys) => { website, instagram } (raw chosen URL or null). Scoring normalizes.
// They deliberately span the retrieval x reasoner space; see the table in the benchmark README.

import { VenueContext } from "./context.ts";
import {
  firecrawlScrapeLinks,
  firecrawlSearch,
  Keys,
  perplexityAgent,
  perplexitySearch,
  perplexitySonar,
  SearchHit,
} from "./providers.ts";
import { normInstagramHandle, normWebsiteHost } from "./normalize.ts";

export type LinkAnswer = { website: string | null; instagram: string | null };
export type StrategyResult = LinkAnswer & { debug?: Record<string, unknown> };
export type Strategy = {
  id: string;
  name: string;
  run: (ctx: VenueContext, keys: Keys) => Promise<StrategyResult>;
};

const LINK_SCHEMA = {
  type: "object",
  properties: {
    website_url: { type: ["string", "null"] },
    instagram_url: { type: ["string", "null"] },
  },
  required: ["website_url", "instagram_url"],
};

// ---- shared candidate helpers ----------------------------------------------
const STOP = new Set([
  "el","la","los","las","de","del","y","the","restaurante","restaurant","cocina",
  "bar","cafe","café","taqueria","taquería","by","en","mx","mexico","méxico",
]);

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function nameTokens(name: string): string[] {
  return stripAccents(name.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}
function domainLabel(host: string): string {
  const parts = host.split(".");
  // second-level label (skip common 2-part TLDs like com.mx)
  if (parts.length >= 3 && ["com", "co", "org", "net"].includes(parts[parts.length - 2])) {
    return parts[parts.length - 3];
  }
  return parts[parts.length - 2] ?? host;
}
/** fraction of the domain label's letters that the venue-name tokens account for. */
function hostNameCoverage(host: string, name: string): number {
  const label = domainLabel(host).replace(/[^a-z0-9]/g, "");
  const toks = nameTokens(name);
  if (!label || !toks.length) return 0;
  let covered = 0;
  let rest = label;
  for (const t of [...toks].sort((a, b) => b.length - a.length)) {
    const idx = rest.indexOf(stripAccents(t));
    if (idx !== -1) {
      covered += t.length;
      rest = rest.slice(0, idx) + rest.slice(idx + t.length);
    }
  }
  return covered / label.length;
}

/** Choose the best official-website URL from search hits by name coverage. */
function pickWebsite(hits: SearchHit[], name: string, minCov = 0.5): string | null {
  for (const h of hits) {
    const host = normWebsiteHost(h.url);
    if (!host) continue; // blocked/junk
    if (hostNameCoverage(host, name) >= minCov) return `https://${host}`;
  }
  return null;
}

/** Extract distinct instagram handles from a bag of URLs, best-name-match first. */
function igCandidates(urls: string[], name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const h = normInstagramHandle(u);
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  const toks = nameTokens(name);
  return out.sort((a, b) => igScore(b, toks) - igScore(a, toks));
}
function igScore(handle: string, toks: string[]): number {
  const h = handle.replace(/[^a-z0-9]/g, "");
  let s = 0;
  for (const t of toks) if (h.includes(stripAccents(t))) s += t.length;
  return s;
}
function igUrl(handle: string | null): string | null {
  return handle ? `https://www.instagram.com/${handle}` : null;
}

// The single highest-precision IG disambiguator: the handle the venue's OWN site links.
// Used to break venue-vs-group and handle-variant ties (Round 2 improvement).
async function footerIgUrls(keys: Keys, site: string | null, name: string): Promise<string[]> {
  if (!site) return [];
  const scraped = await firecrawlScrapeLinks(keys, site);
  if (!scraped) return [];
  return igCandidates(scraped.links, name).map(igUrl).filter(Boolean) as string[];
}

// Judge rubric shared by the Sonar-judge strategies — prefer own-account over group.
const IG_PREFERENCE_RULES =
  "Instagram selection rules, in priority order: (1) STRONGLY prefer a handle that is BOTH in the " +
  "candidate list AND linked from the venue's own official website (marked [site] below); " +
  "(2) prefer the venue's OWN account over a parent brand / group / umbrella account that covers " +
  "many locations; (3) if several official accounts exist, prefer the primary (most-followed / most-active); " +
  "(4) never invent a handle that is not among the candidates; prefer null over a wrong guess.";

function contextLine(ctx: VenueContext): string {
  return (
    `Place: "${ctx.name}" in ${ctx.locationLine}.` +
    (ctx.google?.types?.length ? ` Category: ${ctx.google.types.slice(0, 3).join(", ")}.` : "") +
    (ctx.serpSummary ? `\nContext: ${ctx.serpSummary}` : "")
  );
}

// validate an LLM-returned pair against shape rules; null anything invalid
function validatePair(a: Record<string, unknown>): LinkAnswer {
  const wRaw = typeof a.website_url === "string" ? a.website_url : null;
  const iRaw = typeof a.instagram_url === "string" ? a.instagram_url : null;
  const wHost = normWebsiteHost(wRaw);
  const iHandle = normInstagramHandle(iRaw);
  return { website: wHost ? `https://${wHost}` : null, instagram: igUrl(iHandle) };
}

// =============================================================================
// STRATEGY A — Incumbent (control): Firecrawl-first + footer scrape + Agent fill
// =============================================================================
const stratA: Strategy = {
  id: "A",
  name: "Incumbent (FC search + footer + Agent fill)",
  run: async (ctx, keys) => {
    // 1. website: seed from Google, else one Firecrawl search
    let website = ctx.seedWebsite ? `https://${normWebsiteHost(ctx.seedWebsite)}` : null;
    if (!website) {
      const hits = await firecrawlSearch(keys, `${ctx.name} ${ctx.city} official website`, 5);
      website = pickWebsite(hits, ctx.name);
    }
    // 2. footer: scrape the site, harvest instagram from its own links
    let instagram: string | null = null;
    if (website) {
      const scraped = await firecrawlScrapeLinks(keys, website);
      if (scraped) instagram = igUrl(igCandidates(scraped.links, ctx.name)[0] ?? null);
    }
    // 3. Agent fill for whatever is still missing
    if (!website || !instagram) {
      const { answer } = await perplexityAgent(
        keys,
        `${contextLine(ctx)}\n` +
          (website ? `Known official website: ${website}. ` : "") +
          `Find the official WEBSITE and official INSTAGRAM profile URL for THIS place. ` +
          `A franchise/multi-location brand's main account is acceptable. Prefer null over a guess. ` +
          `Return {"website_url","instagram_url"}.`,
        LINK_SCHEMA,
      );
      const filled = validatePair(answer);
      website = website ?? filled.website;
      instagram = instagram ?? filled.instagram;
    }
    return { website, instagram };
  },
};

// =============================================================================
// STRATEGY B — Pure Agent one-shot (no Firecrawl)
// =============================================================================
const stratB: Strategy = {
  id: "B",
  name: "Pure Agent one-shot",
  run: async (ctx, keys) => {
    const known = ctx.seedWebsite ? `Known official website (from Google): ${ctx.seedWebsite}. ` : "";
    const { answer } = await perplexityAgent(
      keys,
      `${contextLine(ctx)}\n${known}` +
        `Find the official WEBSITE and official INSTAGRAM profile URL for THIS exact place ` +
        `(same brand + same city — not a fan account, not a different-city franchise unless it is ` +
        `the brand's single main account). Anchor on the official website and trust the channels it ` +
        `links. Prefer null over a guess. Return {"website_url","instagram_url"}.`,
      LINK_SCHEMA,
      { maxSteps: 10 },
    );
    const out = validatePair(answer);
    if (!out.website && ctx.seedWebsite) out.website = `https://${normWebsiteHost(ctx.seedWebsite)}`;
    return out;
  },
};

// =============================================================================
// STRATEGY C — Firecrawl recall + footer -> Sonar-pro structured judge
// =============================================================================
const stratC: Strategy = {
  id: "C",
  name: "FC recall -> Sonar judge",
  run: async (ctx, keys) => {
    // MESITA-192 IG retrieval: dual query variants so punctuated / city-suffixed
    // handles enter the candidate pool (Round-4 footer-trust was a no-op when the
    // handle wasn't retrieved at all).
    const [igHits, igHitsAlt, siteHits] = await Promise.all([
      firecrawlSearch(keys, `${ctx.name} ${ctx.city} instagram`, 8),
      firecrawlSearch(keys, `"${ctx.name}" site:instagram.com`, 6),
      firecrawlSearch(keys, `${ctx.name} ${ctx.city} official website`, 6),
    ]);
    const seedSite = ctx.seedWebsite ? `https://${normWebsiteHost(ctx.seedWebsite)}` : null;
    const siteGuess = seedSite ?? pickWebsite(siteHits, ctx.name);
    const footerIg = await footerIgUrls(keys, siteGuess, ctx.name);
    const candidates = dedupeUrls([
      ...(seedSite ? [seedSite] : []),
      ...footerIg,
      ...igHits.map((h) => h.url),
      ...igHitsAlt.map((h) => h.url),
      ...siteHits.map((h) => h.url),
    ]);
    const { answer } = await perplexitySonar(
      keys,
      `You select a venue's official website + Instagram from a candidate list. Return strict JSON. ${IG_PREFERENCE_RULES}`,
      `${contextLine(ctx)}\n\nCandidate URLs (pick ONLY from these; [site] = linked from the ` +
        `venue's own website):\n${renderCandidates(candidates, footerIg)}\n\n` +
        `Return {"website_url": <the official own-domain website or null>, ` +
        `"instagram_url": <the official instagram profile URL or null>}.`,
      LINK_SCHEMA,
    );
    return fillIgFromFooter(validatePair(answer), footerIg);
  },
};

// =============================================================================
// STRATEGY D — Perplexity Search API recall -> Perplexity Agent validate
// =============================================================================
const stratD: Strategy = {
  id: "D",
  name: "PPX-search recall -> Agent validate",
  run: async (ctx, keys) => {
    const [igHits, siteHits] = await Promise.all([
      perplexitySearch(keys, `${ctx.name} ${ctx.city} instagram`, 10),
      perplexitySearch(keys, `${ctx.name} ${ctx.city} sitio oficial`, 10),
    ]);
    const seedSite = ctx.seedWebsite ? `https://${normWebsiteHost(ctx.seedWebsite)}` : null;
    const siteGuess = seedSite ?? pickWebsite(siteHits, ctx.name);
    const footerIg = await footerIgUrls(keys, siteGuess, ctx.name); // Round 2: anchor IG on the site
    const candidates = dedupeUrls([
      ...(ctx.seedWebsite ? [ctx.seedWebsite] : []),
      ...footerIg,
      ...igHits.map((h) => h.url),
      ...siteHits.map((h) => h.url),
    ]).slice(0, 24);
    const { answer } = await perplexityAgent(
      keys,
      `${contextLine(ctx)}\n\nSearch results for this place ([site] = linked from its own website):\n` +
        `${renderCandidates(candidates, footerIg)}\n\n` +
        `Return the official WEBSITE and official INSTAGRAM profile URL for THIS place. ` +
        `Prefer the Instagram handle marked [site]; prefer the venue's own account over a group/umbrella ` +
        `brand account; prefer null over a guess. Return {"website_url","instagram_url"}.`,
      LINK_SCHEMA,
    );
    const out = validatePair(answer);
    if (!out.website && ctx.seedWebsite) out.website = `https://${normWebsiteHost(ctx.seedWebsite)}`;
    return out;
  },
};

// =============================================================================
// STRATEGY E — Dual-retrieval fusion + footer + cross-validating Sonar judge
// =============================================================================
const stratE: Strategy = {
  id: "E",
  name: "Dual fusion + cross-validated judge",
  run: async (ctx, keys) => {
    const [fcIg, fcSite, ppxIg, ppxSite] = await Promise.all([
      firecrawlSearch(keys, `${ctx.name} ${ctx.city} instagram`, 8),
      firecrawlSearch(keys, `${ctx.name} ${ctx.city} official website`, 6),
      perplexitySearch(keys, `${ctx.name} ${ctx.city} instagram`, 8),
      perplexitySearch(keys, `${ctx.name} ${ctx.city} sitio oficial`, 8),
    ]);
    const seedSite = ctx.seedWebsite ? `https://${normWebsiteHost(ctx.seedWebsite)}` : null;
    const siteGuess = seedSite ?? pickWebsite([...fcSite, ...ppxSite], ctx.name);
    const footerIg = await footerIgUrls(keys, siteGuess, ctx.name);
    const candidates = dedupeUrls([
      ...(seedSite ? [seedSite] : []),
      ...footerIg,
      ...fcIg.map((h) => h.url),
      ...ppxIg.map((h) => h.url),
      ...fcSite.map((h) => h.url),
      ...ppxSite.map((h) => h.url),
    ]).slice(0, 30);
    const { answer } = await perplexitySonar(
      keys,
      `You select a venue's official website + Instagram from a candidate list (union of two search ` +
        `engines + the site's own footer). Return strict JSON. Cross-validate: the chosen Instagram ` +
        `handle should plausibly match the website's brand/domain. ${IG_PREFERENCE_RULES}`,
      `${contextLine(ctx)}\n\nCandidate URLs (pick ONLY from these; [site] = linked from the venue's ` +
        `own website):\n${renderCandidates(candidates, footerIg)}\n\n` +
        `Return {"website_url": <official own-domain website or null>, ` +
        `"instagram_url": <official instagram profile URL or null>}. ` +
        `If the venue genuinely has no website, return null for website but still give instagram.`,
      LINK_SCHEMA,
      { searchContextSize: "medium" },
    );
    return fillIgFromFooter(validatePair(answer), footerIg);
  },
};

// =============================================================================
// STRATEGY F — Pure Sonar judge (disable_search) — MESITA-192 deferred variant
// =============================================================================
// Measures whether dropping Firecrawl recall and letting sonar-pro answer blind
// changes precision/recall/cost vs C. Not production — benchmark-only.
const stratF: Strategy = {
  id: "F",
  name: "Pure Sonar judge (disable_search)",
  run: async (ctx, keys) => {
    const seedSite = ctx.seedWebsite ? `https://${normWebsiteHost(ctx.seedWebsite)}` : null;
    const { answer } = await perplexitySonar(
      keys,
      `You find a venue's official website + Instagram from your own knowledge/search. ` +
        `Return strict JSON. Prefer null over a guess. Prefer the venue's OWN account over a ` +
        `parent brand / group account.`,
      `${contextLine(ctx)}\n` +
        (seedSite ? `Known official website (from Google): ${seedSite}.\n` : "") +
        `Return {"website_url": <official own-domain website or null>, ` +
        `"instagram_url": <official instagram profile URL or null>}.`,
      LINK_SCHEMA,
      { disableSearch: true },
    );
    const out = validatePair(answer);
    if (!out.website && seedSite) out.website = seedSite;
    return out;
  },
};

// Round 4 (precision-safe FN recovery): if the judge declined an Instagram but the venue's OWN
// site links one, trust that footer handle. Only fills a null — never overrides a judge pick — so
// it cannot introduce a wrong answer over a correct one; footer = the site linking its own account.
function fillIgFromFooter(out: LinkAnswer, footerIg: string[]): StrategyResult {
  if (!out.instagram && footerIg.length) return { ...out, instagram: footerIg[0] };
  return out;
}

// Render candidate URLs one per line, tagging the ones the venue's own site links.
function renderCandidates(urls: string[], footer: string[]): string {
  const fset = new Set(footer.map((u) => u.toLowerCase().replace(/\/+$/, "")));
  return urls
    .map((u) => (fset.has(u.toLowerCase().replace(/\/+$/, "")) ? `${u}  [site]` : u))
    .join("\n");
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    const k = u.toLowerCase().replace(/\/+$/, "");
    if (!seen.has(k)) {
      seen.add(k);
      out.push(u);
    }
  }
  return out;
}

export const STRATEGIES: Strategy[] = [stratA, stratB, stratC, stratD, stratE, stratF];

export async function runAllStrategies(
  ctx: VenueContext,
  keys: Keys,
): Promise<Record<string, StrategyResult>> {
  const out: Record<string, StrategyResult> = {};
  // sequential to keep provider rate limits happy and cost legible
  for (const s of STRATEGIES) {
    try {
      out[s.id] = await s.run(ctx, keys);
    } catch (e) {
      out[s.id] = { website: null, instagram: null, debug: { error: String(e) } };
    }
  }
  return out;
}
