// Atlas channel URL discovery (Agent Y). Firecrawl Search + Perplexity Agent
// run in PARALLEL for every missing channel, then the resolved set is put
// through a false-positive rejection pass and a false-negative recovery pass.

import {
  canonicaliseUrl,
  domainOf,
  facebookPageFromUrl,
  pickChannel,
  pickFacebook,
  pickInstagram,
  pickWebsite,
  validHost,
} from "./channels.ts";
import { firecrawlScrape, firecrawlSearch } from "./firecrawl.ts";
import { dedup, numOf, safeParseJson } from "./parse-utils.ts";

// Link-discovery = Agent Y, "Firecrawl Search + Perplexity Agent" (ADEA). For
// every channel NOT already supplied by Mesita input or Google data, both
// providers run in PARALLEL: Firecrawl Search surfaces candidate URLs and the
// Perplexity Agent (pro-search) independently validates against the venue's
// own website + fills gaps. Perplexity is NOT a fallback. The selected set is
// then run through two passes: a FALSE-POSITIVE rejection (Firecrawl page-scrape
// verification + a Perplexity handle-page check for instagram/tiktok where
// scrape verification is unreliable) and a FALSE-NEGATIVE recovery (one more
// Perplexity re-search for still-null fields, grounded by the Agent X SERP
// summary + the sibling channels already resolved).
// 50-venue benchmark (2026-06): 82% recall / 76% precision, beating raw
// Firecrawl (77/60) and an all-Perplexity-Search pipeline (75/69).
const PERPLEXITY_AGENT_URL = "https://api.perplexity.ai/v1/agent";
const PERPLEXITY_AGENT_PRESET = "pro-search";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const VISION_MODEL = "gpt-4o-mini";

const CHANNELS_SCHEMA = {
  type: "object",
  properties: {
    instagram_url: { type: ["string", "null"] },
    facebook_url: { type: ["string", "null"] },
    website_url: { type: ["string", "null"] },
  },
} as const;

const DELIVERY_CHANNELS_SCHEMA = {
  type: "object",
  properties: {
    opentable_url: { type: ["string", "null"] },
    uber_eats_url: { type: ["string", "null"] },
  },
} as const;

// ADEA niche-social Link fields (T3): TikTok / TripAdvisor / Yelp. Link-only,
// low-priority, same Firecrawl-Search + Perplexity-Agent chain.
const NICHE_CHANNELS_SCHEMA = {
  type: "object",
  properties: {
    tiktok_url: { type: ["string", "null"] },
    tripadvisor_url: { type: ["string", "null"] },
    yelp_url: { type: ["string", "null"] },
  },
} as const;

// Agent X SERP summary fed into the Perplexity prompts as extra grounding,
// trimmed so it never dominates the prompt budget.
function serpGroundingLine(serpContext?: string): string {
  const s = (serpContext ?? "").trim();
  if (!s) return "";
  return `Background on the venue (web-grounded, soft context — do not treat as the source of any URL):\n${s.slice(0, 600)}\n\n`;
}

// ── Discovery + parsing helpers ─────────────────────────────────────────────

type Channels = {
  instagram_url: string | null;
  facebook_url: string | null;
  website_url: string | null;
};

type DiscoveryField =
  | "website"
  | "instagram"
  | "facebook"
  | "opentable"
  | "ubereats"
  | "tiktok"
  | "tripadvisor"
  | "yelp";
type CandidateProvider = "google" | "seed" | "firecrawl" | "perplexity" | "website_footer";
type CandidateSource = "existing" | "search" | "json_or_citations" | "website_footer";
type DiscoveryCandidate = {
  url: string;
  field: DiscoveryField;
  provider: CandidateProvider;
  source: CandidateSource;
};
type DiscoverySelection = DiscoveryCandidate & { score: number };
type FieldProvenance = {
  url: string | null;
  provider: string | null;
  source: string | null;
  score: number;
  candidate_count: number;
  fallback_used: boolean;
  // Firecrawl and Perplexity both found candidates but pointed to different URLs.
  eyebrow: boolean;
  firecrawl_candidate: string | null;
  perplexity_candidate: string | null;
  primary_path: string;
};

const PRIMARY_PATH: Record<DiscoveryField, string> = {
  website: "google->firecrawl->perplexity(citations)",
  instagram: "website_footer/firecrawl->perplexity(citations)",
  facebook: "website_footer/firecrawl->perplexity(citations)",
  opentable: "firecrawl->perplexity(citations)",
  ubereats: "firecrawl+perplexity(citations) hybrid",
  tiktok: "website_footer/firecrawl->perplexity(citations)",
  tripadvisor: "firecrawl->perplexity(citations)",
  yelp: "firecrawl->perplexity(citations)",
};

const PROVIDER_PRIOR: Record<DiscoveryField, Record<CandidateProvider, number>> = {
  website: { google: 1.2, seed: 0.8, firecrawl: 0.7, perplexity: 0.45, website_footer: 0.65 },
  instagram: { google: 1.0, seed: 0.7, firecrawl: 0.85, perplexity: 0.35, website_footer: 1.1 },
  facebook: { google: 1.0, seed: 0.7, firecrawl: 0.75, perplexity: 0.35, website_footer: 1.0 },
  opentable: { google: 0.6, seed: 0.7, firecrawl: 0.9, perplexity: 0.55, website_footer: 0.9 },
  ubereats: { google: 0.55, seed: 0.7, firecrawl: 0.28, perplexity: 0.42, website_footer: 0.5 },
  // Niche socials: handle-based (tiktok) leans on footer harvest like
  // instagram; listing-based (tripadvisor/yelp) lean on Firecrawl like opentable.
  tiktok: { google: 0.9, seed: 0.7, firecrawl: 0.8, perplexity: 0.35, website_footer: 1.1 },
  tripadvisor: { google: 0.8, seed: 0.7, firecrawl: 0.9, perplexity: 0.5, website_footer: 0.8 },
  yelp: { google: 0.8, seed: 0.7, firecrawl: 0.9, perplexity: 0.5, website_footer: 0.8 },
};

const FIELD_THRESHOLD: Record<DiscoveryField, number> = {
  // Tolerance policy (Atlas Notion benchmark-backed):
  // - stricter: website/facebook/opentable/ubereats (minimize false positives)
  // - softer: instagram (Apify identity-check follows; prefer finding a handle)
  website: 0.52,
  instagram: 0.48,
  facebook: 0.58,
  opentable: 0.58,
  ubereats: 0.52,
  // Niche socials are link-only with no downstream identity check, so keep the
  // bar moderate-to-strict — a wrong niche link is worse than a missing one.
  tiktok: 0.5,
  tripadvisor: 0.55,
  yelp: 0.55,
};

// Provider order per Atlas catalog — Firecrawl + website footer first;
// Perplexity runs in parallel (NOT fallback) and is scored alongside them.
const PRIMARY_PROVIDERS: Record<DiscoveryField, CandidateProvider[]> = {
  website: ["google", "website_footer", "firecrawl"],
  instagram: ["website_footer", "firecrawl", "google"],
  facebook: ["website_footer", "firecrawl", "google"],
  opentable: ["seed", "website_footer", "firecrawl"],
  ubereats: ["seed", "website_footer", "firecrawl"],
  tiktok: ["website_footer", "firecrawl", "google"],
  tripadvisor: ["seed", "website_footer", "firecrawl"],
  yelp: ["seed", "website_footer", "firecrawl"],
};

const GENERIC_PATH_SEGMENTS = new Set([
  "mexico", "monterrey", "cdmx", "guadalajara", "restaurants", "restaurant",
  "delivery", "food", "store", "stores", "city", "near-me", "search",
  "browse", "category", "categories", "mx", "usa", "us",
]);

type DiscoveryContext = {
  nameTokens: string[];
  cityTokens: string[];
};

function foldText(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function tokenise(s: string): string[] {
  const stop = new Set(["the", "and", "san", "de", "del", "la", "el", "los", "las", "restaurant"]);
  return foldText(s)
    .split(/[^a-z0-9]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 && !stop.has(x));
}

function buildDiscoveryContext(name: string, city: string | null, locationLine: string): DiscoveryContext {
  const nameTokens = tokenise(name);
  const cityTokens = dedup([...(city ? tokenise(city) : []), ...tokenise(locationLine)]);
  return { nameTokens, cityTokens };
}

function urlPathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.toLowerCase().split("/").filter(Boolean);
  } catch {
    return [];
  }
}

// A TikTok profile URL is exactly /@handle (reject /video/, /tag/, /discover…).
function isTikTokProfile(url: string): boolean {
  const segs = urlPathSegments(url);
  return segs.length === 1 && segs[0].startsWith("@") && segs[0].length > 1;
}

// A TripAdvisor DETAIL listing (reject city/category/list pages). Detail pages
// carry a -d<id> location id and/or a *_Review path token (Restaurant_Review /
// Hotel_Review / Attraction_Review). A bare "review" substring is too loose — it
// would accept ShowUserReviews / -reviews.html aggregator pages — so anchor it.
function isTripAdvisorListing(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return /[-/]d\d{3,}/.test(path) || /_review[-/]/.test(path);
}

// A Yelp business listing is /biz/<slug> (reject /search, /c/<cat>, city pages).
function isYelpListing(url: string): boolean {
  const segs = urlPathSegments(url);
  return segs[0] === "biz" && segs.length >= 2;
}

function normaliseCandidateForField(field: DiscoveryField, rawUrl: string): string | null {
  const canon = canonicaliseUrl(rawUrl);
  if (!canon) return null;
  if (field === "website") return pickWebsite([canon]);
  if (field === "instagram") return pickInstagram([canon]);
  if (field === "facebook") return pickFacebook([canon]);
  if (field === "opentable") {
    const hit = pickChannel([canon], "opentable_url");
    if (!hit) return null;
    try {
      if (!new URL(hit).pathname.toLowerCase().startsWith("/r/")) return null;
    } catch {
      return null;
    }
    return hit;
  }
  if (field === "ubereats") {
    const hit = pickChannel([canon], "uber_eats_url");
    if (!hit) return null;
    try {
      if (!new URL(hit).pathname.toLowerCase().includes("/store/")) return null;
    } catch {
      return null;
    }
    return hit;
  }
  if (field === "tiktok") {
    const hit = pickChannel([canon], "tiktok_url");
    return hit && isTikTokProfile(hit) ? hit : null;
  }
  if (field === "tripadvisor") {
    const hit = pickChannel([canon], "tripadvisor_url");
    return hit && isTripAdvisorListing(hit) ? hit : null;
  }
  // yelp
  const hit = pickChannel([canon], "yelp_url");
  return hit && isYelpListing(hit) ? hit : null;
}

function addDiscoveryCandidates(
  pool: Record<DiscoveryField, DiscoveryCandidate[]>,
  field: DiscoveryField,
  urls: string[],
  provider: CandidateProvider,
  source: CandidateSource,
): void {
  for (const raw of urls) {
    const url = normaliseCandidateForField(field, raw);
    if (!url) continue;
    pool[field].push({ url, field, provider, source });
  }
}

function scoreCandidate(field: DiscoveryField, c: DiscoveryCandidate, ctx: DiscoveryContext): number {
  let score = PROVIDER_PRIOR[field][c.provider] ?? 0.1;
  if (c.source === "website_footer") score += 1.1;
  let u: URL | null = null;
  try {
    u = new URL(c.url);
  } catch {
    u = null;
  }
  const hay = foldText((u?.hostname ?? "") + (u?.pathname ?? ""));
  let nameBoost = 0;
  for (const t of ctx.nameTokens) {
    if (hay.includes(t)) nameBoost += 0.13;
  }
  let cityBoost = 0;
  for (const t of ctx.cityTokens) {
    if (hay.includes(t)) cityBoost += 0.08;
  }
  score += Math.min(nameBoost, 0.65) + Math.min(cityBoost, 0.24);

  const path = (u?.pathname ?? "").toLowerCase();
  if (field === "facebook" && /(photos|videos|reel|story|posts|events)/.test(path)) score -= 0.4;
  if (field === "website" && /(tripadvisor|yelp|wikipedia|guide\.michelin|theworlds50best)/.test(hay)) {
    score -= 0.8;
  }
  if (field === "instagram" && path.split("/").filter(Boolean).length > 1) score -= 0.2;
  if (field === "ubereats" && !path.includes("/store/")) score -= 1.5;
  if (field === "opentable" && !path.startsWith("/r/")) score -= 1.5;
  for (const seg of path.split("/").filter(Boolean)) {
    if (GENERIC_PATH_SEGMENTS.has(seg)) score -= 0.35;
  }
  if (
    field !== "website" &&
    c.provider === "perplexity" &&
    !ctx.nameTokens.some((t) => hay.includes(t))
  ) {
    score -= 0.45;
  }
  return Math.round(score * 1000) / 1000;
}

function countNameTokensInHay(hay: string, ctx: DiscoveryContext): number {
  let hits = 0;
  for (const t of ctx.nameTokens) {
    if (hay.includes(t)) hits += 1;
  }
  return hits;
}

// Search-sourced candidates must carry at least one venue name token in the
// URL path (footer/google/seed links are trusted without this gate).
export function passesNameGate(
  field: DiscoveryField,
  c: DiscoveryCandidate,
  ctx: DiscoveryContext,
): boolean {
  if (c.provider === "website_footer" || c.provider === "google" || c.provider === "seed") {
    return true;
  }
  let u: URL | null = null;
  try {
    u = new URL(c.url);
  } catch {
    return false;
  }
  const hay = foldText((u.hostname ?? "") + (u.pathname ?? ""));
  const nameHits = countNameTokensInHay(hay, ctx);
  if (
    field === "instagram" || field === "facebook" ||
    field === "tiktok"
  ) {
    // Handle-based: the brand handle carries the name. Perplexity stricter.
    if (c.provider === "perplexity") return nameHits >= 1;
    return nameHits >= 1 || ctx.nameTokens.length === 0;
  }
  if (
    field === "opentable" || field === "ubereats" ||
    field === "tripadvisor" || field === "yelp"
  ) {
    // Listing slugs (and search-sourced links) must carry the venue name.
    return nameHits >= 1;
  }
  return true;
}

function selectBestCandidate(
  field: DiscoveryField,
  candidates: DiscoveryCandidate[],
  ctx: DiscoveryContext,
  providers?: CandidateProvider[],
): DiscoverySelection | null {
  const filtered = candidates.filter((c) =>
    (!providers || providers.includes(c.provider)) && passesNameGate(field, c, ctx)
  );
  if (!filtered.length) return null;
  const bestByUrl = new Map<string, DiscoverySelection>();
  for (const c of filtered) {
    const score = scoreCandidate(field, c, ctx);
    const cur = bestByUrl.get(c.url);
    if (!cur || score > cur.score) bestByUrl.set(c.url, { ...c, score });
  }
  const ranked = [...bestByUrl.values()].sort((a, b) =>
    b.score - a.score || a.url.length - b.url.length || a.url.localeCompare(b.url)
  );
  const top = ranked[0] ?? null;
  if (!top) return null;
  return top.score >= FIELD_THRESHOLD[field] ? top : null;
}

function selectPrimaryCandidate(
  field: DiscoveryField,
  candidates: DiscoveryCandidate[],
  ctx: DiscoveryContext,
): DiscoverySelection | null {
  return selectBestCandidate(field, candidates, ctx, PRIMARY_PROVIDERS[field]);
}

// Uber Eats is a hybrid delivery field: Firecrawl and Perplexity each propose a
// candidate and the winner is the higher-scoring one (small Firecrawl tie-break
// bias).
function selectHybridDelivery(
  field: "ubereats",
  candidates: DiscoveryCandidate[],
  ctx: DiscoveryContext,
): DiscoverySelection | null {
  const fc = selectBestCandidate(
    field,
    candidates,
    ctx,
    ["seed", "website_footer", "firecrawl"],
  );
  const pp = selectBestCandidate(field, candidates, ctx, ["perplexity"]);
  if (fc && pp) {
    if (fc.score >= pp.score - 0.05) return fc;
    return pp.score >= FIELD_THRESHOLD[field] ? pp : fc;
  }
  return fc ?? pp;
}

async function verifyPageMatchesVenue(
  firecrawlKey: string | undefined,
  url: string,
  ctx: DiscoveryContext,
  venueName: string,
): Promise<boolean> {
  if (!firecrawlKey) return true;
  const scraped = await firecrawlScrape(firecrawlKey, url, {
    formats: ["markdown"],
    onlyMainContent: true,
    signalTimeoutMs: 12000,
  });
  if (!scraped?.markdown) return false;
  const metaTitle = typeof scraped.metadata.title === "string" ? scraped.metadata.title : "";
  const metaDesc = typeof scraped.metadata.description === "string"
    ? scraped.metadata.description
    : "";
  const hay = foldText(`${metaTitle} ${metaDesc} ${scraped.markdown.slice(0, 4000)}`);
  const nameHits = countNameTokensInHay(hay, ctx);
  if (nameHits >= 1) return true;
  const brand = foldText(venueName).replace(/[^a-z0-9]/g, "");
  if (brand.length >= 5 && hay.replace(/[^a-z0-9]/g, "").includes(brand.slice(0, Math.min(brand.length, 8)))) {
    return true;
  }
  return false;
}

function isFallbackProvider(field: DiscoveryField, provider: CandidateProvider): boolean {
  if (field === "website") return !["google", "firecrawl"].includes(provider);
  if (
    field === "instagram" || field === "facebook" ||
    field === "tiktok"
  ) {
    return !["google", "firecrawl", "website_footer"].includes(provider);
  }
  if (field === "opentable" || field === "tripadvisor" || field === "yelp") {
    return !["seed", "google", "firecrawl", "website_footer"].includes(provider);
  }
  // Uber Eats delivery hybrid: all four producers are first-class.
  return !["seed", "firecrawl", "perplexity", "website_footer"].includes(provider);
}

function bestCandidateFromProvider(
  field: DiscoveryField,
  candidates: DiscoveryCandidate[],
  provider: CandidateProvider,
  ctx: DiscoveryContext,
): DiscoverySelection | null {
  const filtered = candidates.filter((c) => c.provider === provider);
  if (filtered.length === 0) return null;
  const bestByUrl = new Map<string, DiscoverySelection>();
  for (const c of filtered) {
    const score = scoreCandidate(field, c, ctx);
    const cur = bestByUrl.get(c.url);
    if (!cur || score > cur.score) bestByUrl.set(c.url, { ...c, score });
  }
  const ranked = [...bestByUrl.values()].sort((a, b) =>
    b.score - a.score || a.url.length - b.url.length || a.url.localeCompare(b.url)
  );
  return ranked[0] ?? null;
}

function sameLink(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicaliseUrl(a ?? "");
  const cb = canonicaliseUrl(b ?? "");
  return !!ca && !!cb && ca === cb;
}

// Seed-style provenance for a niche-social field (present = came from the venue
// row, source "existing"; absent = an empty slot to be filled by discovery).
function nicheProvenance(seeded: string | null, primaryPath: string): FieldProvenance {
  return {
    url: seeded,
    provider: seeded ? "seed" : null,
    source: seeded ? "existing" : null,
    score: seeded ? 0.8 : 0,
    candidate_count: 0,
    fallback_used: false,
    eyebrow: false,
    firecrawl_candidate: null,
    perplexity_candidate: null,
    primary_path: primaryPath,
  };
}

// Resolve a venue's official channel URLs (Agent Y). Phases, in order:
//   1. SEED — skip every channel already provided by Mesita input / Google data.
//   2. CANDIDATE GENERATION — for each MISSING field, Firecrawl Search and the
//      Perplexity Agent BOTH run in PARALLEL (Perplexity is NOT a fallback). The
//      Agent X SERP summary (`serpContext`) is threaded into the Perplexity
//      prompts as soft grounding.
//   3. MERGE — every candidate is normalised to its canonical URL + host/shape
//      validated, then pooled per field.
//   4. SELECTION — the existing benchmark-tuned score-based picker chooses the
//      best candidate per field (thresholds + priors unchanged).
//   5. FALSE-POSITIVE rejection — each non-seed pick is re-validated to THIS
//      venue: Firecrawl page-scrape for scrapeable pages, a Perplexity check for
//      instagram/tiktok handle pages where scraping is unreliable. Failures are
//      dropped and their provenance cleared.
//   6. FALSE-NEGATIVE recovery — for fields STILL null, ONE more Perplexity
//      re-search with enriched context (SERP summary + sibling channels already
//      resolved) → new candidates, re-select.
export async function resolveChannels(opts: {
  firecrawlKey?: string;
  perplexityKey?: string;
  name: string;
  city: string | null;
  locationLine: string;
  category: string | null;
  // Agent X SERP summary — soft web-grounded context, threaded into the
  // Perplexity discovery prompts (never the source of a URL).
  serpContext?: string;
  // Tier-2 Link Discovery resolves every channel URL in one agent pass when
  // the caller's source-tier ceiling reaches 2 (all links unlock together).
  resolveReservationDelivery?: boolean;
  // Same gate — TikTok / TripAdvisor / Yelp ride the same agent call.
  resolveNicheSocial?: boolean;
  have: {
    instagram: string | null;
    facebook: string | null;
    website: string | null;
    opentable: string | null;
    uberEats: string | null;
    tiktok?: string | null;
    tripadvisor?: string | null;
    yelp?: string | null;
  };
}): Promise<
  Channels & {
    opentable_url: string | null;
    uber_eats_url: string | null;
    tiktok_url: string | null;
    tripadvisor_url: string | null;
    yelp_url: string | null;
    via: Record<string, string>;
    provenance: Record<DiscoveryField, FieldProvenance>;
  }
> {
  // ── Phase 1: SEED — anything already supplied is kept as-is, never re-resolved.
  let instagram = opts.have.instagram;
  let facebook = opts.have.facebook;
  let website = opts.have.website;
  let opentable = opts.have.opentable;
  let uberEats = opts.have.uberEats;
  let tiktok = opts.have.tiktok ?? null;
  let tripadvisor = opts.have.tripadvisor ?? null;
  let yelp = opts.have.yelp ?? null;
  const wantDelivery = opts.resolveReservationDelivery === true;
  const wantNiche = opts.resolveNicheSocial === true;
  const via: Record<string, string> = {};
  if (instagram) via.instagram = "google";
  if (facebook) via.facebook = "google";
  if (website) via.website = "google";
  if (opentable) via.opentable = "seed";
  if (uberEats) via.ubereats = "seed";
  if (tiktok) via.tiktok = "seed";
  if (tripadvisor) via.tripadvisor = "seed";
  if (yelp) via.yelp = "seed";
  const ctx = buildDiscoveryContext(opts.name, opts.city, opts.locationLine);
  const pool: Record<DiscoveryField, DiscoveryCandidate[]> = {
    website: [],
    instagram: [],
    facebook: [],
    opentable: [],
    ubereats: [],
    tiktok: [],
    tripadvisor: [],
    yelp: [],
  };
  const provenance: Record<DiscoveryField, FieldProvenance> = {
    website: {
      url: website,
      provider: website ? "google" : null,
      source: website ? "existing" : null,
      score: website ? 1.2 : 0,
      candidate_count: 0,
      fallback_used: false,
      eyebrow: false,
      firecrawl_candidate: null,
      perplexity_candidate: null,
      primary_path: PRIMARY_PATH.website,
    },
    instagram: {
      url: instagram,
      provider: instagram ? "google" : null,
      source: instagram ? "existing" : null,
      score: instagram ? 1.0 : 0,
      candidate_count: 0,
      fallback_used: false,
      eyebrow: false,
      firecrawl_candidate: null,
      perplexity_candidate: null,
      primary_path: PRIMARY_PATH.instagram,
    },
    facebook: {
      url: facebook,
      provider: facebook ? "google" : null,
      source: facebook ? "existing" : null,
      score: facebook ? 1.0 : 0,
      candidate_count: 0,
      fallback_used: false,
      eyebrow: false,
      firecrawl_candidate: null,
      perplexity_candidate: null,
      primary_path: PRIMARY_PATH.facebook,
    },
    opentable: {
      url: opentable,
      provider: opentable ? "seed" : null,
      source: opentable ? "existing" : null,
      score: opentable ? 0.8 : 0,
      candidate_count: 0,
      fallback_used: false,
      eyebrow: false,
      firecrawl_candidate: null,
      perplexity_candidate: null,
      primary_path: PRIMARY_PATH.opentable,
    },
    ubereats: {
      url: uberEats,
      provider: uberEats ? "seed" : null,
      source: uberEats ? "existing" : null,
      score: uberEats ? 0.8 : 0,
      candidate_count: 0,
      fallback_used: false,
      eyebrow: false,
      firecrawl_candidate: null,
      perplexity_candidate: null,
      primary_path: PRIMARY_PATH.ubereats,
    },
    tiktok: nicheProvenance(tiktok, PRIMARY_PATH.tiktok),
    tripadvisor: nicheProvenance(tripadvisor, PRIMARY_PATH.tripadvisor),
    yelp: nicheProvenance(yelp, PRIMARY_PATH.yelp),
  };
  const applySelection = (field: DiscoveryField, sel: DiscoverySelection | null): void => {
    provenance[field].candidate_count = pool[field].length;
    if (!sel) return;
    if (field === "website" && !website) website = sel.url;
    if (field === "instagram" && !instagram) instagram = sel.url;
    if (field === "facebook" && !facebook) facebook = sel.url;
    if (field === "opentable" && !opentable) opentable = sel.url;
    if (field === "ubereats" && !uberEats) uberEats = sel.url;
    if (field === "tiktok" && !tiktok) tiktok = sel.url;
    if (field === "tripadvisor" && !tripadvisor) tripadvisor = sel.url;
    if (field === "yelp" && !yelp) yelp = sel.url;
    const viaKey = field === "ubereats" ? "ubereats" : field;
    via[viaKey] = sel.provider;
    provenance[field] = {
      url: sel.url,
      provider: sel.provider,
      source: sel.source,
      score: sel.score,
      candidate_count: pool[field].length,
      fallback_used: isFallbackProvider(field, sel.provider),
      eyebrow: provenance[field].eyebrow,
      firecrawl_candidate: provenance[field].firecrawl_candidate,
      perplexity_candidate: provenance[field].perplexity_candidate,
      primary_path: PRIMARY_PATH[field],
    };
  };

  const scope = [opts.name, opts.city ?? ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");

  // ── Phase 2 (Firecrawl leg) — candidate generation via Firecrawl Search.
  // Intentionally simple queries: "<venue name> <city> <channel>" (no heavy
  // address stuffing). Runs in parallel with the Perplexity leg below.
  if (opts.firecrawlKey) {
    const key = opts.firecrawlKey;
    const searchMany = async (queries: string[]) => {
      const runs = await Promise.all(queries.map((q) => firecrawlSearch(key, q, 6)));
      return dedup(runs.flat()).slice(0, 24);
    };
    const igQueries = [
      `${scope} instagram`,
      `${opts.name} instagram`,
    ];
    const fbQueries = [
      `${scope} facebook`,
      `${opts.name} facebook`,
    ];
    const webQueries = [
      `${scope} website`,
      `${opts.name} website`,
    ];
    const otQueries = [
      `${scope} opentable`,
      `${opts.name} opentable`,
    ];
    const ueQueries = [
      `${scope} uber eats`,
      `${scope} ubereats`,
      `${opts.name} uber eats`,
    ];
    const ttQueries = [`${scope} tiktok`, `${opts.name} tiktok`];
    const taQueries = [`${scope} tripadvisor`, `${opts.name} tripadvisor`];
    const ypQueries = [`${scope} yelp`, `${opts.name} yelp`];
    const needOpenTable = wantDelivery && !opentable;
    const needUberEats = wantDelivery && !uberEats;
    const needTikTok = wantNiche && !tiktok;
    const needTripAdvisor = wantNiche && !tripadvisor;
    const needYelp = wantNiche && !yelp;
    const [igHits, fbHits, webHits, otHits, ueHits, ttHits, taHits, ypHits] =
      await Promise.all([
        instagram ? Promise.resolve<string[]>([]) : searchMany(igQueries),
        facebook ? Promise.resolve<string[]>([]) : searchMany(fbQueries),
        website ? Promise.resolve<string[]>([]) : searchMany(webQueries),
        needOpenTable ? searchMany(otQueries) : Promise.resolve<string[]>([]),
        needUberEats ? searchMany(ueQueries) : Promise.resolve<string[]>([]),
        needTikTok ? searchMany(ttQueries) : Promise.resolve<string[]>([]),
        needTripAdvisor ? searchMany(taQueries) : Promise.resolve<string[]>([]),
        needYelp ? searchMany(ypQueries) : Promise.resolve<string[]>([]),
      ]);
    addDiscoveryCandidates(pool, "instagram", igHits, "firecrawl", "search");
    addDiscoveryCandidates(pool, "facebook", fbHits, "firecrawl", "search");
    addDiscoveryCandidates(pool, "website", webHits, "firecrawl", "search");
    if (needOpenTable) addDiscoveryCandidates(pool, "opentable", otHits, "firecrawl", "search");
    if (needUberEats) addDiscoveryCandidates(pool, "ubereats", ueHits, "firecrawl", "search");
    if (needTikTok) addDiscoveryCandidates(pool, "tiktok", ttHits, "firecrawl", "search");
    if (needTripAdvisor) addDiscoveryCandidates(pool, "tripadvisor", taHits, "firecrawl", "search");
    if (needYelp) addDiscoveryCandidates(pool, "yelp", ypHits, "firecrawl", "search");
    if (!website) applySelection("website", selectPrimaryCandidate("website", pool.website, ctx));

    // Website footer links are strong social/reservation/delivery signals.
    if (website) {
      const home = await firecrawlScrape(key, website, {
        formats: ["markdown"],
        onlyMainContent: false,
        signalTimeoutMs: 15000,
      });
      const links = dedup(Array.isArray(home?.links) ? home!.links : []).slice(0, 120);
      if (links.length) {
        if (!instagram) addDiscoveryCandidates(pool, "instagram", links, "website_footer", "website_footer");
        if (!facebook) addDiscoveryCandidates(pool, "facebook", links, "website_footer", "website_footer");
        if (needOpenTable && !opentable) {
          addDiscoveryCandidates(pool, "opentable", links, "website_footer", "website_footer");
        }
        if (needUberEats && !uberEats) {
          addDiscoveryCandidates(pool, "ubereats", links, "website_footer", "website_footer");
        }
        // Niche socials are very commonly linked from a venue's own footer.
        if (needTikTok && !tiktok) addDiscoveryCandidates(pool, "tiktok", links, "website_footer", "website_footer");
        if (needTripAdvisor && !tripadvisor) addDiscoveryCandidates(pool, "tripadvisor", links, "website_footer", "website_footer");
        if (needYelp && !yelp) addDiscoveryCandidates(pool, "yelp", links, "website_footer", "website_footer");
      }
    }
    if (!instagram) applySelection("instagram", selectPrimaryCandidate("instagram", pool.instagram, ctx));
    if (!facebook) applySelection("facebook", selectPrimaryCandidate("facebook", pool.facebook, ctx));
    if (needOpenTable && !opentable) {
      applySelection("opentable", selectPrimaryCandidate("opentable", pool.opentable, ctx));
    }
    if (needUberEats && !uberEats) {
      applySelection("ubereats", selectPrimaryCandidate("ubereats", pool.ubereats, ctx));
    }
    if (needTikTok && !tiktok) applySelection("tiktok", selectPrimaryCandidate("tiktok", pool.tiktok, ctx));
    if (needTripAdvisor && !tripadvisor) {
      applySelection("tripadvisor", selectPrimaryCandidate("tripadvisor", pool.tripadvisor, ctx));
    }
    if (needYelp && !yelp) applySelection("yelp", selectPrimaryCandidate("yelp", pool.yelp, ctx));
  }

  // ── Phase 2 (Perplexity leg) — candidate generation via the Perplexity Agent,
  // running in PARALLEL with the Firecrawl leg above (NOT a fallback; ADEA
  // policy is both providers always run when the key is present and the tier is
  // unlocked). The agent is handed the best Firecrawl candidate per field to
  // validate + fill, plus the Agent X SERP summary as soft grounding; its
  // candidate is recorded for cross-reference even when Firecrawl wins (the
  // winner is still chosen by score in Phase 4). Uber Eats is hybrid.
  const needPerplexitySocial = !!opts.perplexityKey;
  const needPerplexityDelivery =
    !!opts.perplexityKey && wantDelivery;
  const needPerplexityNiche =
    !!opts.perplexityKey && wantNiche;

  if (
    needPerplexitySocial || needPerplexityDelivery || needPerplexityNiche
  ) {
    const hint = (field: DiscoveryField, current: string | null): string | null =>
      current ?? (pool[field][0]?.url ?? null);
    const [pp, dd, nn] = await Promise.all([
      needPerplexitySocial
        ? discoverChannelsPerplexity(
            opts.perplexityKey!,
            opts.name,
            opts.locationLine,
            opts.category,
            {
              website_url: hint("website", website),
              instagram_url: hint("instagram", instagram),
              facebook_url: hint("facebook", facebook),
            },
            opts.serpContext,
          )
        : Promise.resolve(null),
      needPerplexityDelivery
        ? discoverDeliveryPerplexity(
            opts.perplexityKey!,
            opts.name,
            opts.locationLine,
            opts.category,
            {
              opentable_url: hint("opentable", opentable),
              uber_eats_url: hint("ubereats", uberEats),
            },
            opts.serpContext,
          )
        : Promise.resolve(null),
      needPerplexityNiche
        ? discoverNichePerplexity(
            opts.perplexityKey!,
            opts.name,
            opts.locationLine,
            opts.category,
            {
              tiktok_url: hint("tiktok", tiktok),
              tripadvisor_url: hint("tripadvisor", tripadvisor),
              yelp_url: hint("yelp", yelp),
            },
            opts.serpContext,
          )
        : Promise.resolve(null),
    ]);

    if (pp) {
      if (!instagram && pp.instagram_url) {
        addDiscoveryCandidates(pool, "instagram", [pp.instagram_url], "perplexity", "json_or_citations");
      }
      if (!facebook && pp.facebook_url) {
        addDiscoveryCandidates(pool, "facebook", [pp.facebook_url], "perplexity", "json_or_citations");
      }
      if (!website && pp.website_url) {
        addDiscoveryCandidates(pool, "website", [pp.website_url], "perplexity", "json_or_citations");
      }
    }

    if (dd) {
      if (!opentable && dd.opentable_url) {
        addDiscoveryCandidates(pool, "opentable", [dd.opentable_url], "perplexity", "json_or_citations");
      }
      if (dd.uber_eats_url) {
        addDiscoveryCandidates(pool, "ubereats", [dd.uber_eats_url], "perplexity", "json_or_citations");
      }
    }

    if (nn) {
      if (!tiktok && nn.tiktok_url) {
        addDiscoveryCandidates(pool, "tiktok", [nn.tiktok_url], "perplexity", "json_or_citations");
      }
      if (!tripadvisor && nn.tripadvisor_url) {
        addDiscoveryCandidates(pool, "tripadvisor", [nn.tripadvisor_url], "perplexity", "json_or_citations");
      }
      if (!yelp && nn.yelp_url) {
        addDiscoveryCandidates(pool, "yelp", [nn.yelp_url], "perplexity", "json_or_citations");
      }
    }

    // ── Phase 4: SELECTION — score-based picker per field (thresholds + priors
    // unchanged). Uber Eats goes through the hybrid Firecrawl/Perplexity
    // chooser; the rest pick the best Perplexity candidate now that both legs
    // have contributed to the pool.
    if (!website) {
      applySelection(
        "website",
        selectBestCandidate("website", pool.website, ctx, ["perplexity"]),
      );
    }
    if (!instagram) {
      applySelection(
        "instagram",
        selectBestCandidate("instagram", pool.instagram, ctx, ["perplexity"]),
      );
    }
    if (!facebook) {
      applySelection(
        "facebook",
        selectBestCandidate("facebook", pool.facebook, ctx, ["perplexity"]),
      );
    }
    if (wantDelivery && !opentable) {
      applySelection(
        "opentable",
        selectBestCandidate("opentable", pool.opentable, ctx, ["perplexity"]),
      );
    }
    if (wantDelivery && !uberEats) {
      applySelection("ubereats", selectHybridDelivery("ubereats", pool.ubereats, ctx));
    }
    if (wantNiche && !tiktok) {
      applySelection("tiktok", selectBestCandidate("tiktok", pool.tiktok, ctx, ["perplexity"]));
    }
    if (wantNiche && !tripadvisor) {
      applySelection("tripadvisor", selectBestCandidate("tripadvisor", pool.tripadvisor, ctx, ["perplexity"]));
    }
    if (wantNiche && !yelp) {
      applySelection("yelp", selectBestCandidate("yelp", pool.yelp, ctx, ["perplexity"]));
    }

    // Cross-reference: record each provider's candidate per field and flag a
    // disagreement (eyebrow) — even when Firecrawl already won the selection.
    // This never changes the winner; it only annotates provenance for the
    // false-positive / false-negative review passes below.
    const ppByField: Partial<Record<DiscoveryField, string | null>> = {
      website: pp?.website_url ?? null,
      instagram: pp?.instagram_url ?? null,
      facebook: pp?.facebook_url ?? null,
      opentable: dd?.opentable_url ?? null,
      ubereats: dd?.uber_eats_url ?? null,
      tiktok: nn?.tiktok_url ?? null,
      tripadvisor: nn?.tripadvisor_url ?? null,
      yelp: nn?.yelp_url ?? null,
    };
    const sameChannelUrl = (a: string | null, b: string | null): boolean => {
      if (!a || !b) return false;
      const norm = (u: string) =>
        u.trim().toLowerCase()
          .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
      return norm(a) === norm(b);
    };
    for (const field of Object.keys(pool) as DiscoveryField[]) {
      const fc = pool[field].find((c) => c.provider === "firecrawl")?.url ?? null;
      const pc = ppByField[field] ?? null;
      provenance[field].firecrawl_candidate = fc;
      provenance[field].perplexity_candidate = pc;
      provenance[field].eyebrow = !!fc && !!pc && !sameChannelUrl(fc, pc);
    }
  } else if (wantDelivery && !uberEats) {
    // No Perplexity key: Uber Eats falls back to the Firecrawl-only pick.
    applySelection("ubereats", selectPrimaryCandidate("ubereats", pool.ubereats, ctx));
  }

  // ── Phase 5: FALSE-POSITIVE rejection — validate every non-seed selected link
  // truly belongs to THIS venue and drop the ones that fail, clearing their
  // provenance. Two verifiers: Firecrawl page-scrape for scrapeable pages
  // (facebook / opentable / ubereats / tripadvisor / yelp) and a
  // Perplexity check for instagram + tiktok handle pages, where scrape
  // verification is unreliable. (instagram is ALSO re-verified downstream by the
  // IG scrape; the Perplexity check here is a cheap extra guard.)
  const rejectField = (field: DiscoveryField): void => {
    provenance[field] = {
      ...provenance[field],
      url: null,
      provider: null,
      source: null,
      score: 0,
      fallback_used: false,
    };
  };
  if (opts.firecrawlKey) {
    if (facebook && via.facebook !== "google") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, facebook, ctx, opts.name);
      if (!ok) {
        facebook = null;
        delete via.facebook;
        rejectField("facebook");
      }
    }
    if (opentable && via.opentable !== "seed") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, opentable, ctx, opts.name);
      if (!ok) {
        opentable = null;
        delete via.opentable;
        rejectField("opentable");
      }
    }
    if (uberEats && via.ubereats !== "seed") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, uberEats, ctx, opts.name);
      if (!ok) {
        uberEats = null;
        delete via.ubereats;
        rejectField("ubereats");
      }
    }
    // TripAdvisor + Yelp are scrapeable listing pages — verify the venue name
    // appears, same as OpenTable.
    if (tripadvisor && via.tripadvisor !== "seed") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, tripadvisor, ctx, opts.name);
      if (!ok) {
        tripadvisor = null;
        delete via.tripadvisor;
        rejectField("tripadvisor");
      }
    }
    if (yelp && via.yelp !== "seed") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, yelp, ctx, opts.name);
      if (!ok) {
        yelp = null;
        delete via.yelp;
        rejectField("yelp");
      }
    }
  }

  // Perplexity false-positive check for handle pages (instagram / tiktok), where
  // a Firecrawl scrape often can't see enough to confirm the account. The agent
  // gets the venue + sibling channels and answers keep/reject per non-seed pick.
  if (opts.perplexityKey) {
    if (instagram && via.instagram !== "google") {
      const ok = await verifyHandlePerplexity(
        opts.perplexityKey, opts.name, opts.locationLine, opts.category,
        instagram, { website, facebook }, opts.serpContext,
      );
      if (!ok) {
        instagram = null;
        delete via.instagram;
        rejectField("instagram");
      }
    }
    if (tiktok && via.tiktok !== "seed") {
      const ok = await verifyHandlePerplexity(
        opts.perplexityKey, opts.name, opts.locationLine, opts.category,
        tiktok, { website, instagram }, opts.serpContext,
      );
      if (!ok) {
        tiktok = null;
        delete via.tiktok;
        rejectField("tiktok");
      }
    }
  }

  // ── Phase 6: FALSE-NEGATIVE recovery — for fields STILL null after Phase 5, do
  // ONE more Perplexity re-search with enriched context (the Agent X SERP
  // summary + the sibling channels already resolved, e.g. "their website is X
  // and instagram is Y — find their TikTok") and re-select. Only runs when at
  // least one resolvable field is missing AND we have something to ground on.
  if (opts.perplexityKey) {
    const siblings = { website, instagram, facebook };
    const missingSocial = (!instagram || !facebook || !website);
    const missingTikTok = wantNiche && !tiktok;
    if ((missingSocial || missingTikTok) && (website || instagram || facebook)) {
      const recovered = await recoverChannelsPerplexity(
        opts.perplexityKey, opts.name, opts.locationLine, opts.category,
        { wantWebsite: !website, wantInstagram: !instagram, wantFacebook: !facebook, wantTikTok: missingTikTok },
        siblings, opts.serpContext,
      );
      if (recovered) {
        if (!website && recovered.website_url) {
          addDiscoveryCandidates(pool, "website", [recovered.website_url], "perplexity", "json_or_citations");
          applySelection("website", selectBestCandidate("website", pool.website, ctx, ["perplexity"]));
        }
        if (!instagram && recovered.instagram_url) {
          addDiscoveryCandidates(pool, "instagram", [recovered.instagram_url], "perplexity", "json_or_citations");
          applySelection("instagram", selectBestCandidate("instagram", pool.instagram, ctx, ["perplexity"]));
        }
        if (!facebook && recovered.facebook_url) {
          addDiscoveryCandidates(pool, "facebook", [recovered.facebook_url], "perplexity", "json_or_citations");
          applySelection("facebook", selectBestCandidate("facebook", pool.facebook, ctx, ["perplexity"]));
        }
        if (missingTikTok && recovered.tiktok_url) {
          addDiscoveryCandidates(pool, "tiktok", [recovered.tiktok_url], "perplexity", "json_or_citations");
          applySelection("tiktok", selectBestCandidate("tiktok", pool.tiktok, ctx, ["perplexity"]));
        }
      }
    }
  }

  for (
    const field of [
      "website", "instagram", "facebook", "opentable", "ubereats",
      "tiktok", "tripadvisor", "yelp",
    ] as DiscoveryField[]
  ) {
    provenance[field].candidate_count = pool[field].length;
    const firecrawlTop = bestCandidateFromProvider(field, pool[field], "firecrawl", ctx);
    const perplexityTop = bestCandidateFromProvider(field, pool[field], "perplexity", ctx);
    provenance[field].firecrawl_candidate = firecrawlTop?.url ?? null;
    provenance[field].perplexity_candidate = perplexityTop?.url ?? null;
    if (
      firecrawlTop?.url &&
      perplexityTop?.url &&
      !sameLink(firecrawlTop.url, perplexityTop.url)
    ) {
      provenance[field].eyebrow = true;
    }
  }

  return {
    instagram_url: instagram,
    facebook_url: facebook,
    website_url: website,
    opentable_url: opentable,
    uber_eats_url: uberEats,
    tiktok_url: tiktok,
    tripadvisor_url: tripadvisor,
    yelp_url: yelp,
    via,
    provenance,
  };
}


// ── Perplexity Agent (pro-search) discovery: validate + fill ────────────────
// Calls the managed Agent runtime once and returns both the schema JSON answer
// and the source URLs the agent actually cited (annotations). Host-locked:
// callers must re-validate every URL before trusting it.
async function callPerplexityAgent(
  key: string,
  input: string,
  schema: unknown,
): Promise<{ answer: Record<string, unknown>; hitUrls: string[] } | null> {
  try {
    const r = await fetch(PERPLEXITY_AGENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input,
        preset: PERPLEXITY_AGENT_PRESET,
        instructions:
          "Resolve venue URLs by anchoring on the official website and trusting the links the site itself points to. Output only JSON matching the schema. Never fabricate URLs; prefer null when unsure.",
        max_steps: 8,
        response_format: { type: "json_schema", json_schema: { schema } },
      }),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      output?: {
        type?: string;
        content?: { text?: string; annotations?: { url?: unknown }[] }[];
      }[];
    };
    let text = "";
    const hitUrls: string[] = [];
    for (const it of d.output ?? []) {
      if (it?.type === "message" && Array.isArray(it.content)) {
        for (const c of it.content) {
          if (typeof c?.text === "string") text += c.text;
          for (const a of c?.annotations ?? []) {
            if (a && typeof a.url === "string") hitUrls.push(a.url);
          }
        }
      }
    }
    const answer = (safeParseJson(text) as Record<string, unknown> | null) ?? {};
    return { answer, hitUrls };
  } catch {
    return null;
  }
}

// Perplexity Agent (pro-search) social/website discovery. `hints` carries the
// best Firecrawl candidates so the agent verifies them (keep / fix / null)
// rather than rediscovering from scratch. Trusts the website-anchored JSON
// answer first, then falls back to mined citation URLs — both host-validated.
export async function discoverChannelsPerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
  hints: Partial<Channels> = {},
  serpContext?: string,
): Promise<Channels | null> {
  const hintLines = [
    hints.website_url ? `- website (candidate): ${hints.website_url}` : "",
    hints.instagram_url ? `- instagram (candidate): ${hints.instagram_url}` : "",
    hints.facebook_url ? `- facebook (candidate): ${hints.facebook_url}` : "",
  ].filter(Boolean).join("\n");
  const prompt =
    `Resolve official links for the venue "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + ".\n" +
    serpGroundingLine(serpContext) +
    (hintLines
      ? `An automated search proposed these CANDIDATES — they may be wrong (a different venue, a news article, an aggregator, or a generic page). Verify each; do not trust them blindly:\n${hintLines}\n\n`
      : "") +
    `Find the official WEBSITE first and trust the Instagram/Facebook the site itself links to. ` +
    `Return strict JSON with instagram_url, facebook_url, website_url.\n` +
    `- website_url and facebook_url: strict — null if you cannot confirm it belongs to THIS venue.\n` +
    `- instagram_url: return the best plausible official profile; null only if no good lead.\n` +
    `Brand-level account/site is acceptable for chains. Never invent URLs.`;
  const res = await callPerplexityAgent(key, prompt, CHANNELS_SCHEMA);
  if (!res) return null;
  const { answer, hitUrls } = res;
  const instagram_url =
    pickInstagram([String(answer.instagram_url ?? "")]) ??
    validHost(answer.instagram_url, ["instagram.com"]) ??
    pickInstagram(hitUrls);
  // Agent answers are website-anchored evidence, so we trust the JSON for
  // facebook/website first, then fall back to cited URLs.
  const facebook_url =
    pickFacebook([String(answer.facebook_url ?? "")]) ?? pickFacebook(hitUrls);
  const website_url =
    pickWebsite([String(answer.website_url ?? "")]) ?? pickWebsite(hitUrls);
  if (!instagram_url && !facebook_url && !website_url) return null;
  return { instagram_url, facebook_url, website_url };
}

// Perplexity Agent (pro-search) directory discovery (OpenTable + Uber Eats).
async function discoverDeliveryPerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
  hints: {
    opentable_url?: string | null;
    uber_eats_url?: string | null;
  } = {},
  serpContext?: string,
): Promise<
  { opentable_url: string | null; uber_eats_url: string | null } | null
> {
  const hintLines = [
    hints.opentable_url ? `- opentable (candidate): ${hints.opentable_url}` : "",
    hints.uber_eats_url ? `- uber eats (candidate): ${hints.uber_eats_url}` : "",
  ].filter(Boolean).join("\n");
  const prompt =
    `Resolve reservation and delivery links for "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + ".\n" +
    serpGroundingLine(serpContext) +
    (hintLines
      ? `An automated search proposed these CANDIDATES — verify each, they may be wrong or a different location:\n${hintLines}\n\n`
      : "") +
    `Return strict JSON with:\n` +
    `- opentable_url: the canonical OpenTable restaurant page (opentable.com or a country domain like opentable.com.mx). The specific location is best; the brand page is acceptable. null if the venue is genuinely not on OpenTable.\n` +
    `- uber_eats_url: the canonical Uber Eats store page (ubereats.com). The specific store is best; brand page acceptable. null if not on Uber Eats.\n` +
    `Be conservative (low false positives). If unsure, use null. Never invent a URL.`;
  const res = await callPerplexityAgent(key, prompt, DELIVERY_CHANNELS_SCHEMA);
  if (!res) return null;
  const { answer, hitUrls } = res;
  const opentable_url =
    pickChannel([String(answer.opentable_url ?? "")], "opentable_url") ??
    pickChannel(hitUrls, "opentable_url");
  const uber_eats_url =
    pickChannel([String(answer.uber_eats_url ?? "")], "uber_eats_url") ??
    pickChannel(hitUrls, "uber_eats_url");
  if (!opentable_url && !uber_eats_url) return null;
  return { opentable_url, uber_eats_url };
}

// Perplexity Agent (pro-search) niche-social discovery (TikTok / TripAdvisor /
// Yelp). Same host-locked discipline as the other agent paths: every returned
// URL is re-validated to the right host AND a profile/listing shape (@handle,
// detail listing, /biz/ slug) before it is trusted — the agent's prose/citations
// are never used raw.
async function discoverNichePerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
  hints: {
    tiktok_url?: string | null;
    tripadvisor_url?: string | null;
    yelp_url?: string | null;
  } = {},
  serpContext?: string,
): Promise<
  {
    tiktok_url: string | null;
    tripadvisor_url: string | null;
    yelp_url: string | null;
  } | null
> {
  const hintLines = [
    hints.tiktok_url ? `- tiktok (candidate): ${hints.tiktok_url}` : "",
    hints.tripadvisor_url ? `- tripadvisor (candidate): ${hints.tripadvisor_url}` : "",
    hints.yelp_url ? `- yelp (candidate): ${hints.yelp_url}` : "",
  ].filter(Boolean).join("\n");
  const prompt =
    `Resolve niche profile/listing links for the venue "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + ".\n" +
    serpGroundingLine(serpContext) +
    (hintLines
      ? `An automated search proposed these CANDIDATES — verify each, they may be wrong or a different venue:\n${hintLines}\n\n`
      : "") +
    `Return strict JSON with:\n` +
    `- tiktok_url: the venue's TikTok profile (tiktok.com/@handle). Never a single video. null if none.\n` +
    `- tripadvisor_url: the venue's TripAdvisor detail/listing page (a Restaurant_Review / -d… page, not a city or category list). null if none.\n` +
    `- yelp_url: the venue's Yelp business page (yelp.com/biz/<slug>). null if none.\n` +
    `Be conservative (low false positives). These channels are rare for many venues — prefer null over a guess. Never invent a URL.`;
  const res = await callPerplexityAgent(key, prompt, NICHE_CHANNELS_SCHEMA);
  if (!res) return null;
  const { answer, hitUrls } = res;
  const pickNiche = (
    raw: unknown,
    channel: "tiktok_url" | "tripadvisor_url" | "yelp_url",
    shape: (u: string) => boolean,
  ): string | null => {
    const fromAnswer = pickChannel([String(raw ?? "")], channel);
    if (fromAnswer && shape(fromAnswer)) return fromAnswer;
    for (const u of hitUrls) {
      const hit = pickChannel([u], channel);
      if (hit && shape(hit)) return hit;
    }
    return null;
  };
  const tiktok_url = pickNiche(answer.tiktok_url, "tiktok_url", isTikTokProfile);
  const tripadvisor_url = pickNiche(answer.tripadvisor_url, "tripadvisor_url", isTripAdvisorListing);
  const yelp_url = pickNiche(answer.yelp_url, "yelp_url", isYelpListing);
  if (!tiktok_url && !tripadvisor_url && !yelp_url) return null;
  return { tiktok_url, tripadvisor_url, yelp_url };
}

// ── Phase 5 helper: Perplexity false-positive check for a handle page ────────
// Instagram + TikTok profiles can't be reliably confirmed by a Firecrawl scrape
// (login walls / JS), so we ask the agent whether `url` is THIS venue's (or its
// brand's) official handle. Lenient like the IG identity judge — accept a
// brand/franchise main account; reject only a clearly different business. The
// answer is the only thing trusted (no URL is read from it). Fails OPEN on any
// agent error (missing a handle is worse than keeping a plausible one).
async function verifyHandlePerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
  url: string,
  siblings: { website?: string | null; facebook?: string | null; instagram?: string | null },
  serpContext?: string,
): Promise<boolean> {
  const sibLines = [
    siblings.website ? `- website: ${siblings.website}` : "",
    siblings.facebook ? `- facebook: ${siblings.facebook}` : "",
    siblings.instagram ? `- instagram: ${siblings.instagram}` : "",
  ].filter(Boolean).join("\n");
  const prompt =
    `Does this social profile belong to the venue "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + `, OR to the brand/chain it is ` +
    `part of? Profile: ${url}\n` +
    serpGroundingLine(serpContext) +
    (sibLines ? `Known official channels of this venue:\n${sibLines}\n\n` : "") +
    `A franchise / multi-location brand's MAIN account counts as a match even ` +
    `when it isn't specific to this location. Answer false ONLY when the profile ` +
    `is clearly a DIFFERENT, unrelated business.\n` +
    `Return strict JSON: {"match": true} or {"match": false}.`;
  const res = await callPerplexityAgent(key, prompt, {
    type: "object",
    properties: { match: { type: "boolean" } },
  });
  if (!res) return true; // fail open
  return res.answer.match !== false;
}

// ── Phase 6 helper: Perplexity false-negative recovery ───────────────────────
// One more targeted pass for the fields STILL null after FP, grounded by the
// sibling channels we DID resolve + the Agent X SERP summary. Only the requested
// fields are asked for. Host/shape-validated like every other agent leg.
async function recoverChannelsPerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
  want: { wantWebsite: boolean; wantInstagram: boolean; wantFacebook: boolean; wantTikTok: boolean },
  siblings: { website?: string | null; instagram?: string | null; facebook?: string | null },
  serpContext?: string,
): Promise<
  {
    website_url: string | null;
    instagram_url: string | null;
    facebook_url: string | null;
    tiktok_url: string | null;
  } | null
> {
  const sibLines = [
    siblings.website ? `- website: ${siblings.website}` : "",
    siblings.instagram ? `- instagram: ${siblings.instagram}` : "",
    siblings.facebook ? `- facebook: ${siblings.facebook}` : "",
  ].filter(Boolean).join("\n");
  const askLines = [
    want.wantWebsite ? `- website_url: the venue's official website. null if none.` : "",
    want.wantInstagram ? `- instagram_url: the venue's Instagram profile (instagram.com/<handle>). Brand account acceptable. null if none.` : "",
    want.wantFacebook ? `- facebook_url: the venue's official Facebook page. null if none.` : "",
    want.wantTikTok ? `- tiktok_url: the venue's TikTok profile (tiktok.com/@handle). null if none.` : "",
  ].filter(Boolean).join("\n");
  if (!askLines) return null;
  const prompt =
    `Find the MISSING official links for the venue "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + ".\n" +
    serpGroundingLine(serpContext) +
    (sibLines
      ? `We already know these official channels — use them to anchor the search (the missing channels almost always share the same brand handle / link from these):\n${sibLines}\n\n`
      : "") +
    `Return strict JSON with ONLY these keys (null any you cannot confirm):\n${askLines}\n` +
    `Never invent a URL. Prefer null over a guess.`;
  const res = await callPerplexityAgent(key, prompt, {
    type: "object",
    properties: {
      website_url: { type: ["string", "null"] },
      instagram_url: { type: ["string", "null"] },
      facebook_url: { type: ["string", "null"] },
      tiktok_url: { type: ["string", "null"] },
    },
  });
  if (!res) return null;
  const { answer, hitUrls } = res;
  const website_url = want.wantWebsite
    ? (pickWebsite([String(answer.website_url ?? "")]) ?? pickWebsite(hitUrls))
    : null;
  const instagram_url = want.wantInstagram
    ? (pickInstagram([String(answer.instagram_url ?? "")]) ?? pickInstagram(hitUrls))
    : null;
  const facebook_url = want.wantFacebook
    ? (pickFacebook([String(answer.facebook_url ?? "")]) ?? pickFacebook(hitUrls))
    : null;
  let tiktok_url: string | null = null;
  if (want.wantTikTok) {
    const fromAnswer = pickChannel([String(answer.tiktok_url ?? "")], "tiktok_url");
    if (fromAnswer && isTikTokProfile(fromAnswer)) {
      tiktok_url = fromAnswer;
    } else {
      for (const u of hitUrls) {
        const hit = pickChannel([u], "tiktok_url");
        if (hit && isTikTokProfile(hit)) {
          tiktok_url = hit;
          break;
        }
      }
    }
  }
  if (!website_url && !instagram_url && !facebook_url && !tiktok_url) return null;
  return { website_url, instagram_url, facebook_url, tiktok_url };
}

// Normalise a phone candidate to E.164-ish digits (a leading + plus 7–15 digits)
// or null. Strips spaces/punctuation; assumes the agent returns the country code.
function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return hasPlus ? `+${digits}` : digits;
}

// ── Agent Y last-resort PHONE leg ────────────────────────────────────────────
// Phone is NOT a URL, so it lives outside the channel pool. This is the final
// fallback used only when the Mesita seed + Google data gave us no phone: a
// single Perplexity Agent lookup for the venue's official public phone, grounded
// by its website + the Agent X SERP summary. Returns a normalised number or null
// (null on anything uncertain — a wrong number is worse than a missing one).
export async function discoverPhonePerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
  hints: { website?: string | null; serpContext?: string } = {},
): Promise<string | null> {
  const prompt =
    `Find the official public phone number for the venue "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + ".\n" +
    serpGroundingLine(hints.serpContext) +
    (hints.website ? `Its official website is ${hints.website} — trust the number it lists.\n\n` : "") +
    `Return strict JSON {"phone": "<number in international format, e.g. +52...>"} ` +
    `or {"phone": null} if you cannot confirm it. Never invent a number.`;
  const res = await callPerplexityAgent(key, prompt, {
    type: "object",
    properties: { phone: { type: ["string", "null"] } },
  });
  if (!res) return null;
  return normalisePhone(res.answer.phone);
}

// Normalise an email candidate to a lowercased, format-valid address or null.
function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  // Strict-enough shape: local@domain.tld, no spaces. Rejects obvious junk.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
}

// ── Agent Y last-resort EMAIL leg ────────────────────────────────────────────
// Email is NOT a URL either, so it lives outside the channel pool. Final
// fallback used only when the Mesita seed + Google data gave us no email: a
// single Perplexity Agent lookup for the venue's official public email, grounded
// by its website (prefer an address on the site's own domain) + the Agent X SERP
// summary. Returns a format-valid address or null (null on anything uncertain).
export async function discoverEmailPerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
  hints: { website?: string | null; serpContext?: string } = {},
): Promise<string | null> {
  const prompt =
    `Find the official public contact email for the venue "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + ".\n" +
    serpGroundingLine(hints.serpContext) +
    (hints.website ? `Its official website is ${hints.website} — strongly prefer an email on that domain.\n\n` : "") +
    `Return strict JSON {"email": "<address>"} or {"email": null} if you cannot ` +
    `confirm it. Never invent an address.`;
  const res = await callPerplexityAgent(key, prompt, {
    type: "object",
    properties: { email: { type: ["string", "null"] } },
  });
  if (!res) return null;
  return normaliseEmail(res.answer.email);
}


// Bare page slug of a Facebook URL, usable as an Instagram-handle candidate
// (venues reuse handles across networks). Numeric profile.php?id= pages and
// anything outside the IG handle charset (≤30 of [A-Za-z0-9._]) return null.
export function fbSlugCandidate(url: string | null | undefined): string | null {
  const page = facebookPageFromUrl(url);
  if (!page) return null;
  let seg: string;
  try {
    seg = new URL(page).pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return null;
  }
  if (!seg || seg === "profile.php") return null;
  return /^[A-Za-z0-9._]{2,30}$/.test(seg) ? seg : null;
}

// The Instagram profile scraper returns a non-null object even for a handle
// that DOESN'T EXIST: the requested username echoed back with every data field
// null/empty. That empty stub must be rejected before identity verification, or
// a guessed handle (e.g. a Facebook slug reused as an IG handle) could be
// "verified" against nothing. A real account always carries at least followers,
// a display name, a bio, or recent posts — a stub carries none of these.
export function isDeadIgStub(p: Record<string, unknown>): boolean {
  if (typeof p.error === "string" && p.error.length > 0) return true;
  const hasFollowers = numOf(p.followersCount) != null;
  const hasName = typeof p.fullName === "string" && p.fullName.trim().length > 0;
  const hasBio = typeof p.biography === "string" && p.biography.trim().length > 0;
  const hasPosts = Array.isArray(p.latestPosts) && p.latestPosts.length > 0;
  return !hasFollowers && !hasName && !hasBio && !hasPosts;
}

// Does this scraped Instagram profile belong to THIS venue or its brand? We
// confirm before trusting it, but lean GENEROUS — a missing IG is a worse miss
// than a brand-level one. Instant yes on a bio link to the venue's website
// domain, agreement with the Facebook page slug, or a handle/name carrying the
// venue's brand (so franchises resolve to their one brand account). Otherwise
// an LLM judge decides, biased toward TRUE, rejecting only a clearly different
// business. No OpenAI key → fall back to the brand/slug signals above only.
export async function igProfileMatchesVenue(
  p: Record<string, unknown>,
  venue: {
    name: string;
    locationLine: string;
    website: string | null;
    facebook: string | null;
    category: string | null;
  },
  openaiKey: string | undefined,
  corroborateFb = true,
): Promise<boolean> {
  const username = typeof p.username === "string" ? p.username : "";
  const fullName = typeof p.fullName === "string" ? p.fullName : "";
  const bio = typeof p.biography === "string" ? p.biography : "";
  const links: string[] = [];
  if (typeof p.externalUrl === "string") links.push(p.externalUrl);
  if (Array.isArray(p.externalUrls)) {
    for (const e of p.externalUrls) {
      const u = (e as { url?: unknown })?.url;
      if (typeof u === "string") links.push(u);
    }
  }

  // Strong signal: the IG bio link points to the venue's own website domain.
  const wd = domainOf(venue.website);
  if (wd && links.some((l) => domainOf(l) === wd)) return true;

  const fold = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const norm = (s: string) => fold(s).replace(/[^a-z0-9]/g, "");
  const uname = norm(username);
  const fname = norm(fullName);

  // Strong signal: an INDEPENDENTLY-discovered IG handle/name lines up with the
  // venue's Facebook page slug (venues reuse handles across networks, so
  // fb.com/Stranasanpedro + ig handle "stranasanpedro" is the same brand). Skip
  // when the candidate was derived FROM that slug — then it'd vouch for itself.
  const fbKey = corroborateFb ? norm(fbSlugCandidate(venue.facebook) ?? "") : "";
  if (fbKey.length >= 5 && (uname === fbKey || fname === fbKey)) return true;

  // Strong signal: the handle/name carries the venue's BRAND — its name minus
  // the city/location words. Franchises and multi-location brands run ONE
  // account for the whole brand, so "Mochomos Monterrey" → @mochomos is the
  // right match even though the handle isn't location-specific. We'd rather
  // attach the brand account than show nothing — a missing IG is the worse miss.
  const locTokens = new Set(
    fold(venue.locationLine)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
  const brandKey = norm(
    fold(venue.name)
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !locTokens.has(w))
      .join(""),
  );
  if (brandKey.length >= 5 && (uname.includes(brandKey) || fname.includes(brandKey))) {
    return true;
  }

  if (!openaiKey) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 80,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content:
              `Decide if an Instagram profile belongs to the venue below OR to the ` +
              `brand/chain it is part of. For a franchise or multi-location business ` +
              `the brand's MAIN account counts as a match even when it isn't specific ` +
              `to this location. Answer false ONLY when the profile is clearly a ` +
              `DIFFERENT, unrelated business; when the name plausibly matches the ` +
              `venue or its brand, prefer true.\n\n` +
              `Venue: "${venue.name}"` +
              (venue.locationLine ? `, ${venue.locationLine}` : "") +
              (venue.category ? `, category: ${venue.category}` : "") +
              (venue.website ? `, website: ${venue.website}` : "") +
              (venue.facebook ? `, facebook: ${venue.facebook}` : "") +
              `\nInstagram: @${username}, name: "${fullName}", bio: "${bio.slice(0, 500)}", ` +
              `links: ${links.join(", ") || "none"}\n\n` +
              `Reply JSON {"match": true} or {"match": false}.`,
          },
        ],
      }),
    });
    if (!r.ok) return false;
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const obj = safeParseJson(data.choices?.[0]?.message?.content ?? "") as
      | { match?: unknown }
      | null;
    return obj?.match === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
