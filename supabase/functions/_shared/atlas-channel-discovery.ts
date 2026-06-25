// Atlas channel URL discovery: Firecrawl search, Perplexity fallback, IG verify.

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

// Link-discovery fallback = "Firecrawl Search and Perplexity Agent" (ADEA):
// Firecrawl Search surfaces candidate URLs, then the Perplexity Agent
// (pro-search) validates them against the venue's own website and fills gaps.
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

// ADEA niche-social Link fields (T3): YouTube / TikTok / TripAdvisor / Yelp.
// Link-only, low-priority, same Firecrawl-Search + Perplexity-Agent chain.
const NICHE_CHANNELS_SCHEMA = {
  type: "object",
  properties: {
    youtube_url: { type: ["string", "null"] },
    tiktok_url: { type: ["string", "null"] },
    tripadvisor_url: { type: ["string", "null"] },
    yelp_url: { type: ["string", "null"] },
  },
} as const;

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
  | "youtube"
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
  youtube: "website_footer/firecrawl->perplexity(citations)",
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
  // Niche socials: handle-based (youtube/tiktok) lean on footer harvest like
  // instagram; listing-based (tripadvisor/yelp) lean on Firecrawl like opentable.
  youtube: { google: 0.9, seed: 0.7, firecrawl: 0.8, perplexity: 0.35, website_footer: 1.1 },
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
  youtube: 0.5,
  tiktok: 0.5,
  tripadvisor: 0.55,
  yelp: 0.55,
};

// Provider order per Atlas catalog — Firecrawl + website footer first;
// Perplexity is fallback-only except Uber Eats (hybrid).
const PRIMARY_PROVIDERS: Record<DiscoveryField, CandidateProvider[]> = {
  website: ["google", "website_footer", "firecrawl"],
  instagram: ["website_footer", "firecrawl", "google"],
  facebook: ["website_footer", "firecrawl", "google"],
  opentable: ["seed", "website_footer", "firecrawl"],
  ubereats: ["seed", "website_footer", "firecrawl"],
  youtube: ["website_footer", "firecrawl", "google"],
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

// A YouTube CHANNEL/profile URL (not a video, playlist, short, or search).
// Accepts /@handle, /channel/UC…, /c/Name, /user/Name, and legacy vanity /Name.
function isYouTubeChannel(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  if (host === "youtu.be") return false; // short video links, never a channel
  const segs = urlPathSegments(url);
  if (!segs.length) return false;
  const first = segs[0];
  // Only the four canonical CHANNEL forms (ADEA spec: @handle, /channel/UC…,
  // /c/Name, /user/Name). Bare vanity (/Name) is deliberately rejected — YouTube
  // deprecated it, and accepting any single segment would let system paths
  // (/music, /account, /tv, /upload, /kids, …) through as false channels.
  if (first.startsWith("@") && first.length > 1) return true;
  if (first === "channel" || first === "c" || first === "user") return segs.length >= 2;
  return false;
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
  if (field === "youtube") {
    const hit = pickChannel([canon], "youtube_url");
    return hit && isYouTubeChannel(hit) ? hit : null;
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
    field === "youtube" || field === "tiktok"
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

function selectHybridUberEats(
  candidates: DiscoveryCandidate[],
  ctx: DiscoveryContext,
): DiscoverySelection | null {
  const fc = selectBestCandidate(
    "ubereats",
    candidates,
    ctx,
    ["seed", "website_footer", "firecrawl"],
  );
  const pp = selectBestCandidate("ubereats", candidates, ctx, ["perplexity"]);
  if (fc && pp) {
    if (fc.score >= pp.score - 0.05) return fc;
    return pp.score >= FIELD_THRESHOLD.ubereats ? pp : fc;
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
    field === "youtube" || field === "tiktok"
  ) {
    return !["google", "firecrawl", "website_footer"].includes(provider);
  }
  if (field === "opentable" || field === "tripadvisor" || field === "yelp") {
    return !["seed", "google", "firecrawl", "website_footer"].includes(provider);
  }
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

// Resolve a venue's official channel URLs. Order (matches the Atlas catalog):
//   1. whatever Google already gave us (passed in via `have`)
//   2. Firecrawl Search on "<name> <city> <network>" — the strongest signal for
//      socials, since the canonical profile is almost always the top result
//   3. Perplexity — last-resort fallback for anything still missing
// Only missing channels are searched, and every candidate is normalised to the
// canonical profile URL + host-validated before we trust it.
export async function resolveChannels(opts: {
  firecrawlKey?: string;
  perplexityKey?: string;
  name: string;
  city: string | null;
  locationLine: string;
  category: string | null;
  // Tier-3 OpenTable + UberEats resolution is opt-in: the caller only flips
  // this on when the venue's source-tier ceiling reaches 3.
  resolveReservationDelivery?: boolean;
  // Tier-3 niche socials (YouTube / TikTok / TripAdvisor / Yelp), same gate.
  resolveNicheSocial?: boolean;
  have: {
    instagram: string | null;
    facebook: string | null;
    website: string | null;
    opentable: string | null;
    uberEats: string | null;
    youtube?: string | null;
    tiktok?: string | null;
    tripadvisor?: string | null;
    yelp?: string | null;
  };
}): Promise<
  Channels & {
    opentable_url: string | null;
    uber_eats_url: string | null;
    youtube_url: string | null;
    tiktok_url: string | null;
    tripadvisor_url: string | null;
    yelp_url: string | null;
    via: Record<string, string>;
    provenance: Record<DiscoveryField, FieldProvenance>;
  }
> {
  let instagram = opts.have.instagram;
  let facebook = opts.have.facebook;
  let website = opts.have.website;
  let opentable = opts.have.opentable;
  let uberEats = opts.have.uberEats;
  let youtube = opts.have.youtube ?? null;
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
  if (youtube) via.youtube = "seed";
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
    youtube: [],
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
    youtube: nicheProvenance(youtube, PRIMARY_PATH.youtube),
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
    if (field === "youtube" && !youtube) youtube = sel.url;
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

  // 2. Firecrawl Search — intentionally simple queries:
  // "<venue name> <city> <channel>" (no heavy address stuffing).
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
    const ytQueries = [`${scope} youtube`, `${opts.name} youtube channel`];
    const ttQueries = [`${scope} tiktok`, `${opts.name} tiktok`];
    const taQueries = [`${scope} tripadvisor`, `${opts.name} tripadvisor`];
    const ypQueries = [`${scope} yelp`, `${opts.name} yelp`];
    const needOpenTable = wantDelivery && !opentable;
    const needUberEats = wantDelivery && !uberEats;
    const needYouTube = wantNiche && !youtube;
    const needTikTok = wantNiche && !tiktok;
    const needTripAdvisor = wantNiche && !tripadvisor;
    const needYelp = wantNiche && !yelp;
    const [igHits, fbHits, webHits, otHits, ueHits, ytHits, ttHits, taHits, ypHits] =
      await Promise.all([
        instagram ? Promise.resolve<string[]>([]) : searchMany(igQueries),
        facebook ? Promise.resolve<string[]>([]) : searchMany(fbQueries),
        website ? Promise.resolve<string[]>([]) : searchMany(webQueries),
        needOpenTable ? searchMany(otQueries) : Promise.resolve<string[]>([]),
        needUberEats ? searchMany(ueQueries) : Promise.resolve<string[]>([]),
        needYouTube ? searchMany(ytQueries) : Promise.resolve<string[]>([]),
        needTikTok ? searchMany(ttQueries) : Promise.resolve<string[]>([]),
        needTripAdvisor ? searchMany(taQueries) : Promise.resolve<string[]>([]),
        needYelp ? searchMany(ypQueries) : Promise.resolve<string[]>([]),
      ]);
    addDiscoveryCandidates(pool, "instagram", igHits, "firecrawl", "search");
    addDiscoveryCandidates(pool, "facebook", fbHits, "firecrawl", "search");
    addDiscoveryCandidates(pool, "website", webHits, "firecrawl", "search");
    if (needOpenTable) addDiscoveryCandidates(pool, "opentable", otHits, "firecrawl", "search");
    if (needUberEats) addDiscoveryCandidates(pool, "ubereats", ueHits, "firecrawl", "search");
    if (needYouTube) addDiscoveryCandidates(pool, "youtube", ytHits, "firecrawl", "search");
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
        if (needYouTube && !youtube) addDiscoveryCandidates(pool, "youtube", links, "website_footer", "website_footer");
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
    if (needYouTube && !youtube) applySelection("youtube", selectPrimaryCandidate("youtube", pool.youtube, ctx));
    if (needTikTok && !tiktok) applySelection("tiktok", selectPrimaryCandidate("tiktok", pool.tiktok, ctx));
    if (needTripAdvisor && !tripadvisor) {
      applySelection("tripadvisor", selectPrimaryCandidate("tripadvisor", pool.tripadvisor, ctx));
    }
    if (needYelp && !yelp) applySelection("yelp", selectPrimaryCandidate("yelp", pool.yelp, ctx));
  }

  // 3. Perplexity Agent — fallback only (ADEA policy). Never re-run when
  // Firecrawl/website-footer already resolved a channel. The agent is handed
  // the best Firecrawl candidate per field to validate + fill. Uber Eats is
  // hybrid: always run, then pick the best validated candidate.
  const needPerplexitySocial =
    !!opts.perplexityKey && (!instagram || !facebook || !website);
  const needPerplexityOpenTable =
    !!opts.perplexityKey && wantDelivery && !opentable;
  const needPerplexityUberEats =
    !!opts.perplexityKey && wantDelivery;
  const needPerplexityNiche =
    !!opts.perplexityKey && wantNiche &&
    (!youtube || !tiktok || !tripadvisor || !yelp);

  if (
    needPerplexitySocial || needPerplexityOpenTable ||
    needPerplexityUberEats || needPerplexityNiche
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
          )
        : Promise.resolve(null),
      (needPerplexityOpenTable || needPerplexityUberEats)
        ? discoverDeliveryPerplexity(
            opts.perplexityKey!,
            opts.name,
            opts.locationLine,
            opts.category,
            {
              opentable_url: hint("opentable", opentable),
              uber_eats_url: hint("ubereats", uberEats),
            },
          )
        : Promise.resolve(null),
      needPerplexityNiche
        ? discoverNichePerplexity(
            opts.perplexityKey!,
            opts.name,
            opts.locationLine,
            opts.category,
            {
              youtube_url: hint("youtube", youtube),
              tiktok_url: hint("tiktok", tiktok),
              tripadvisor_url: hint("tripadvisor", tripadvisor),
              yelp_url: hint("yelp", yelp),
            },
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
      if (!youtube && nn.youtube_url) {
        addDiscoveryCandidates(pool, "youtube", [nn.youtube_url], "perplexity", "json_or_citations");
      }
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
      applySelection("ubereats", selectHybridUberEats(pool.ubereats, ctx));
    }
    if (wantNiche && !youtube) {
      applySelection("youtube", selectBestCandidate("youtube", pool.youtube, ctx, ["perplexity"]));
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
  } else if (wantDelivery && !uberEats) {
    applySelection("ubereats", selectPrimaryCandidate("ubereats", pool.ubereats, ctx));
  }

  // 4. Firecrawl page verification for links that persist without Apify gating.
  if (opts.firecrawlKey) {
    if (facebook && via.facebook !== "google") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, facebook, ctx, opts.name);
      if (!ok) {
        facebook = null;
        delete via.facebook;
        provenance.facebook = {
          ...provenance.facebook,
          url: null,
          provider: null,
          source: null,
          score: 0,
          fallback_used: false,
        };
      }
    }
    if (opentable && via.opentable !== "seed") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, opentable, ctx, opts.name);
      if (!ok) {
        opentable = null;
        delete via.opentable;
        provenance.opentable = {
          ...provenance.opentable,
          url: null,
          provider: null,
          source: null,
          score: 0,
          fallback_used: false,
        };
      }
    }
    if (uberEats && via.ubereats !== "seed") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, uberEats, ctx, opts.name);
      if (!ok) {
        uberEats = null;
        delete via.ubereats;
        provenance.ubereats = {
          ...provenance.ubereats,
          url: null,
          provider: null,
          source: null,
          score: 0,
          fallback_used: false,
        };
      }
    }
    // TripAdvisor + Yelp are scrapeable listing pages — verify the venue name
    // appears, same as OpenTable. (YouTube/TikTok are handle pages where scrape
    // verification is unreliable, so they rely on the URL-shape validators.)
    if (tripadvisor && via.tripadvisor !== "seed") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, tripadvisor, ctx, opts.name);
      if (!ok) {
        tripadvisor = null;
        delete via.tripadvisor;
        provenance.tripadvisor = {
          ...provenance.tripadvisor,
          url: null,
          provider: null,
          source: null,
          score: 0,
          fallback_used: false,
        };
      }
    }
    if (yelp && via.yelp !== "seed") {
      const ok = await verifyPageMatchesVenue(opts.firecrawlKey, yelp, ctx, opts.name);
      if (!ok) {
        yelp = null;
        delete via.yelp;
        provenance.yelp = {
          ...provenance.yelp,
          url: null,
          provider: null,
          source: null,
          score: 0,
          fallback_used: false,
        };
      }
    }
  }

  for (
    const field of [
      "website", "instagram", "facebook", "opentable", "ubereats",
      "youtube", "tiktok", "tripadvisor", "yelp",
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
    youtube_url: youtube,
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
  hints: { opentable_url?: string | null; uber_eats_url?: string | null } = {},
): Promise<{ opentable_url: string | null; uber_eats_url: string | null } | null> {
  const hintLines = [
    hints.opentable_url ? `- opentable (candidate): ${hints.opentable_url}` : "",
    hints.uber_eats_url ? `- uber eats (candidate): ${hints.uber_eats_url}` : "",
  ].filter(Boolean).join("\n");
  const prompt =
    `Resolve reservation and delivery links for "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + ".\n" +
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

// Perplexity Agent (pro-search) niche-social discovery (YouTube / TikTok /
// TripAdvisor / Yelp). Same host-locked discipline as the other agent paths:
// every returned URL is re-validated to the right host AND a profile/listing
// shape (channel page, @handle, detail listing, /biz/ slug) before it is
// trusted — the agent's prose/citations are never used raw.
async function discoverNichePerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
  hints: {
    youtube_url?: string | null;
    tiktok_url?: string | null;
    tripadvisor_url?: string | null;
    yelp_url?: string | null;
  } = {},
): Promise<
  {
    youtube_url: string | null;
    tiktok_url: string | null;
    tripadvisor_url: string | null;
    yelp_url: string | null;
  } | null
> {
  const hintLines = [
    hints.youtube_url ? `- youtube (candidate): ${hints.youtube_url}` : "",
    hints.tiktok_url ? `- tiktok (candidate): ${hints.tiktok_url}` : "",
    hints.tripadvisor_url ? `- tripadvisor (candidate): ${hints.tripadvisor_url}` : "",
    hints.yelp_url ? `- yelp (candidate): ${hints.yelp_url}` : "",
  ].filter(Boolean).join("\n");
  const prompt =
    `Resolve niche profile/listing links for the venue "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + ".\n" +
    (hintLines
      ? `An automated search proposed these CANDIDATES — verify each, they may be wrong or a different venue:\n${hintLines}\n\n`
      : "") +
    `Return strict JSON with:\n` +
    `- youtube_url: the venue's YouTube CHANNEL page (youtube.com/@handle, /channel/…, /c/…, or /user/…). Never a video or playlist. null if none.\n` +
    `- tiktok_url: the venue's TikTok profile (tiktok.com/@handle). Never a single video. null if none.\n` +
    `- tripadvisor_url: the venue's TripAdvisor detail/listing page (a Restaurant_Review / -d… page, not a city or category list). null if none.\n` +
    `- yelp_url: the venue's Yelp business page (yelp.com/biz/<slug>). null if none.\n` +
    `Be conservative (low false positives). These channels are rare for many venues — prefer null over a guess. Never invent a URL.`;
  const res = await callPerplexityAgent(key, prompt, NICHE_CHANNELS_SCHEMA);
  if (!res) return null;
  const { answer, hitUrls } = res;
  const pickNiche = (
    raw: unknown,
    channel: "youtube_url" | "tiktok_url" | "tripadvisor_url" | "yelp_url",
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
  const youtube_url = pickNiche(answer.youtube_url, "youtube_url", isYouTubeChannel);
  const tiktok_url = pickNiche(answer.tiktok_url, "tiktok_url", isTikTokProfile);
  const tripadvisor_url = pickNiche(answer.tripadvisor_url, "tripadvisor_url", isTripAdvisorListing);
  const yelp_url = pickNiche(answer.yelp_url, "yelp_url", isYelpListing);
  if (!youtube_url && !tiktok_url && !tripadvisor_url && !yelp_url) return null;
  return { youtube_url, tiktok_url, tripadvisor_url, yelp_url };
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
