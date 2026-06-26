// Atlas channel URL discovery — Step S3, WEBSITE-FIRST: a venue's own site footer
// is the highest-precision source of its official channels, so we anchor on the
// website, classify its outbound links, then make ONE Perplexity Agent call — P3,
// the niche gap-filler — to fill only what's still missing. Every URL is host + shape
// validated before it's trusted. No scoring engine, no multi-pass FP/FN review.
//
//   Phase 0  SEED      keep anything already supplied (Google/Mesita); freeze it.
//   Phase 1  ANCHOR    if no website, one Firecrawl search to find it.
//   Phase 2  FOOTER    scrape the site, classifyLinks() the footer, validate.
//   Phase 3  FILL      one Perplexity Agent call for fields still missing.
//                      (no Perplexity key → degraded per-field Firecrawl search)
//
// Phone + email are NOT URLs; they ride outside the channel set as last-resort
// Perplexity lookups (discoverPhonePerplexity / discoverEmailPerplexity), used
// by the orchestrator only when the seed + Google gave nothing.

import {
  canonicaliseUrl,
  classifyLinks,
  domainOf,
  pickChannel,
  pickFacebook,
  pickInstagram,
  pickWebsite,
} from "./channels.ts";
import { firecrawlScrape, firecrawlSearch } from "./firecrawl.ts";
import { callPerplexityAgent } from "./perplexity-agent.ts";
import { dedup } from "./parse-utils.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type ChannelField =
  | "website_url"
  | "instagram_url"
  | "facebook_url"
  | "opentable_url"
  | "uber_eats_url"
  | "tiktok_url"
  | "tripadvisor_url"
  | "yelp_url";

type ChannelMap = Record<ChannelField, string | null>;
type ChannelSource = "seed" | "website" | "search" | "perplexity";

const CHANNEL_FIELDS: ChannelField[] = [
  "website_url",
  "instagram_url",
  "facebook_url",
  "opentable_url",
  "uber_eats_url",
  "tiktok_url",
  "tripadvisor_url",
  "yelp_url",
];

export type ResolvedChannels = ChannelMap & {
  // Diagnostics only (orchestrator stuffs these into sources.discovery).
  via: Partial<Record<ChannelField, ChannelSource>>;
  provenance: Partial<Record<ChannelField, { source: ChannelSource; url: string }>>;
};

// ── Shape validators (real domain knowledge, kept verbatim) ──────────────────

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

// A TripAdvisor DETAIL listing (reject city/category/list pages): a -d<id>
// location id and/or a *_Review path token, anchored so aggregator pages fail.
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

function pathStartsWith(url: string, prefix: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().startsWith(prefix);
  } catch {
    return false;
  }
}

function pathIncludes(url: string, frag: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().includes(frag);
  } catch {
    return false;
  }
}

// Canonicalise + host-route + shape-gate a candidate for one field. Returns the
// canonical URL or null. The single gate every candidate (footer, Perplexity
// answer, citation, degraded search) passes through before it is trusted.
export function validateFieldUrl(field: ChannelField, rawUrl: string): string | null {
  const canon = canonicaliseUrl(rawUrl);
  if (!canon) return null;
  switch (field) {
    case "website_url":
      return pickWebsite([canon]);
    case "instagram_url":
      return pickInstagram([canon]);
    case "facebook_url":
      return pickFacebook([canon]);
    case "opentable_url": {
      const hit = pickChannel([canon], "opentable_url");
      return hit && pathStartsWith(hit, "/r/") ? hit : null;
    }
    case "uber_eats_url": {
      const hit = pickChannel([canon], "uber_eats_url");
      return hit && pathIncludes(hit, "/store/") ? hit : null;
    }
    case "tiktok_url": {
      const hit = pickChannel([canon], "tiktok_url");
      return hit && isTikTokProfile(hit) ? hit : null;
    }
    case "tripadvisor_url": {
      const hit = pickChannel([canon], "tripadvisor_url");
      return hit && isTripAdvisorListing(hit) ? hit : null;
    }
    case "yelp_url": {
      const hit = pickChannel([canon], "yelp_url");
      return hit && isYelpListing(hit) ? hit : null;
    }
  }
}

function firstValidFromList(field: ChannelField, urls: string[]): string | null {
  for (const u of urls) {
    const v = validateFieldUrl(field, u);
    if (v) return v;
  }
  return null;
}

// Minimal tokeniser for the one place we still name-match: the website anchor.
function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

// ── Phase 1 — anchor the official website ────────────────────────────────────
// One Firecrawl search. Prefer a result whose host carries a venue-name token
// (guards against harvesting a different business's footer), else first plausible.
async function findWebsite(
  firecrawlKey: string,
  name: string,
  city: string | null,
): Promise<string | null> {
  const scope = [name, city ?? ""].map((s) => s.trim()).filter(Boolean).join(" ");
  const runs = await Promise.all([
    firecrawlSearch(firecrawlKey, `${scope} official website`, 5),
    firecrawlSearch(firecrawlKey, `${name} website`, 5),
  ]);
  const results = dedup(runs.flat());
  const sites = results
    .map((u) => pickWebsite([u]))
    .filter((u): u is string => !!u);
  if (!sites.length) return null;
  const toks = nameTokens(name);
  const named = sites.find((u) => {
    const h = domainOf(u) ?? "";
    return toks.some((t) => h.includes(t));
  });
  return named ?? sites[0];
}

// ── Phase 2 — harvest the website footer ─────────────────────────────────────
// Scrape the homepage with onlyMainContent:false (footer links live outside main
// content), classify the outbound links, shape-validate each wanted hit. Footer
// links are trusted on host+shape alone — they are the links the venue itself
// points at. Best-effort: null website / scrape failure → {}.
async function harvestFooter(
  firecrawlKey: string,
  website: string,
  want: Set<ChannelField>,
): Promise<Partial<ChannelMap>> {
  const scraped = await firecrawlScrape(firecrawlKey, website, {
    formats: ["markdown"],
    onlyMainContent: false,
    signalTimeoutMs: 15000,
  });
  const links = dedup(Array.isArray(scraped?.links) ? scraped!.links : []).slice(0, 120);
  if (!links.length) return {};
  const classified = classifyLinks(links);
  const out: Partial<ChannelMap> = {};
  for (const f of CHANNEL_FIELDS) {
    if (f === "website_url" || !want.has(f)) continue;
    const raw = classified[f];
    if (!raw) continue;
    const valid = validateFieldUrl(f, raw);
    if (valid) out[f] = valid;
  }
  return out;
}

// ── Phase 3 — one Perplexity Agent call to fill what's still missing ─────────
// The schema is built dynamically so the agent is only asked for the missing
// fields. Already-resolved siblings anchor the prompt. Every returned URL (JSON
// answer first, then cited URLs) is host + shape validated. Also reused by S4
// (atlas-instagram.ts) to re-find an Instagram handle. Best-effort → {}.
const FILL_FIELD_SPEC: Record<ChannelField, string> = {
  website_url: "website_url: the venue's official website. null if none.",
  instagram_url:
    "instagram_url: the venue's Instagram profile (instagram.com/<handle>). A brand/franchise main account is acceptable. null if none.",
  facebook_url: "facebook_url: the venue's official Facebook page. null if none.",
  opentable_url:
    "opentable_url: the canonical OpenTable restaurant page (opentable.com/r/… or a country domain). Brand page acceptable. null if not on OpenTable.",
  uber_eats_url:
    "uber_eats_url: the canonical Uber Eats store page (ubereats.com/.../store/...). null if not on Uber Eats.",
  tiktok_url:
    "tiktok_url: the venue's TikTok profile (tiktok.com/@handle), never a single video. null if none.",
  tripadvisor_url:
    "tripadvisor_url: the venue's TripAdvisor detail page (a Restaurant_Review / -d… page, not a city or category list). null if none.",
  yelp_url: "yelp_url: the venue's Yelp business page (yelp.com/biz/<slug>). null if none.",
};

function serpGroundingLine(serpContext?: string): string {
  const s = (serpContext ?? "").trim();
  if (!s) return "";
  return `Background on the venue (web-grounded, soft context — do not treat as the source of any URL):\n${s.slice(0, 600)}\n\n`;
}

export async function fillMissingChannels(
  key: string,
  venue: { name: string; locationLine: string; category: string | null },
  want: Set<ChannelField>,
  siblings: Partial<ChannelMap> = {},
  serpContext?: string,
): Promise<Partial<ChannelMap>> {
  const fields = CHANNEL_FIELDS.filter((f) => want.has(f));
  if (!fields.length) return {};

  const properties: Record<string, { type: string[] }> = {};
  for (const f of fields) properties[f] = { type: ["string", "null"] };
  const schema = { type: "object", properties };

  const sibLines = (["website_url", "instagram_url", "facebook_url"] as ChannelField[])
    .filter((f) => siblings[f])
    .map((f) => `- ${f}: ${siblings[f]}`)
    .join("\n");
  const askLines = fields.map((f) => `- ${FILL_FIELD_SPEC[f]}`).join("\n");

  const prompt =
    `Find the official online channels for the venue "${venue.name}"` +
    (venue.locationLine ? ` in ${venue.locationLine}` : "") +
    (venue.category ? ` (category: ${venue.category})` : "") + ".\n" +
    serpGroundingLine(serpContext) +
    (sibLines
      ? `Anchor on these already-known official channels (the missing ones almost always share the same brand handle / are linked from these):\n${sibLines}\n\n`
      : "") +
    `Find the official WEBSITE first and trust the channels the site itself links to. ` +
    `Return strict JSON with ONLY these keys (null any you cannot confirm belongs to THIS venue):\n${askLines}\n` +
    `A franchise / multi-location brand's MAIN account or page is acceptable. ` +
    `Be conservative — prefer null over a guess. Never invent a URL.`;

  const res = await callPerplexityAgent(key, prompt, schema);
  if (!res) return {};
  const { answer, hitUrls } = res;
  const out: Partial<ChannelMap> = {};
  for (const f of fields) {
    const fromAnswer = typeof answer[f] === "string"
      ? validateFieldUrl(f, answer[f] as string)
      : null;
    const valid = fromAnswer ?? firstValidFromList(f, hitUrls);
    if (valid) out[f] = valid;
  }
  return out;
}

// ── Degraded leg — Firecrawl per-field search (only when no Perplexity key) ──
async function firecrawlSearchFill(
  firecrawlKey: string,
  name: string,
  city: string | null,
  want: Set<ChannelField>,
): Promise<Partial<ChannelMap>> {
  const scope = [name, city ?? ""].map((s) => s.trim()).filter(Boolean).join(" ");
  const term: Record<ChannelField, string> = {
    website_url: "official website",
    instagram_url: "instagram",
    facebook_url: "facebook",
    opentable_url: "opentable",
    uber_eats_url: "uber eats",
    tiktok_url: "tiktok",
    tripadvisor_url: "tripadvisor",
    yelp_url: "yelp",
  };
  const fields = CHANNEL_FIELDS.filter((f) => want.has(f));
  const runs = await Promise.all(
    fields.map((f) => firecrawlSearch(firecrawlKey, `${scope} ${term[f]}`, 6)),
  );
  const out: Partial<ChannelMap> = {};
  fields.forEach((f, i) => {
    const valid = firstValidFromList(f, dedup(runs[i]));
    if (valid) out[f] = valid;
  });
  return out;
}

// ── resolveChannels — Step S3 link-discovery entry (P3 is the gap-fill within) ──
export async function resolveChannels(opts: {
  firecrawlKey?: string;
  perplexityKey?: string;
  name: string;
  city: string | null;
  locationLine: string;
  category: string | null;
  // P2 SERP summary — soft grounding for the Perplexity fill prompt.
  serpContext?: string;
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
}): Promise<ResolvedChannels> {
  const { firecrawlKey, perplexityKey, name, city, locationLine, category, serpContext } = opts;

  // Phase 0 — SEED. Anything already supplied is frozen, never re-resolved.
  const out: ChannelMap = {
    website_url: opts.have.website,
    instagram_url: opts.have.instagram,
    facebook_url: opts.have.facebook,
    opentable_url: opts.have.opentable,
    uber_eats_url: opts.have.uberEats,
    tiktok_url: opts.have.tiktok ?? null,
    tripadvisor_url: opts.have.tripadvisor ?? null,
    yelp_url: opts.have.yelp ?? null,
  };
  const via: ResolvedChannels["via"] = {};
  const provenance: ResolvedChannels["provenance"] = {};
  for (const f of CHANNEL_FIELDS) {
    const u = out[f];
    if (u) {
      via[f] = "seed";
      provenance[f] = { source: "seed", url: u };
    }
  }

  const missing = (): Set<ChannelField> => new Set(CHANNEL_FIELDS.filter((f) => !out[f]));
  const fill = (field: ChannelField, url: string | null, source: ChannelSource): void => {
    if (!url || out[field]) return;
    out[field] = url;
    via[field] = source;
    provenance[field] = { source, url };
  };

  const assemble = (): ResolvedChannels => ({ ...out, via, provenance });

  // Nothing missing, or no provider keys → return the seed unchanged.
  if (missing().size === 0 || (!firecrawlKey && !perplexityKey)) return assemble();

  // Phase 1 — ANCHOR the website (so Phase 2 has a footer to harvest).
  if (!out.website_url && firecrawlKey) {
    const site = await findWebsite(firecrawlKey, name, city);
    if (site) fill("website_url", site, "search");
  }

  // Phase 2 — HARVEST the footer (highest precision: the venue's own links).
  if (out.website_url && firecrawlKey && missing().size > 0) {
    const harvested = await harvestFooter(firecrawlKey, out.website_url, missing());
    for (const f of CHANNEL_FIELDS) {
      const u = harvested[f];
      if (u) fill(f, u, "website");
    }
  }

  // Phase 3 — FILL the rest with ONE Perplexity call (or degraded Firecrawl).
  if (missing().size > 0) {
    if (perplexityKey) {
      const siblings: Partial<ChannelMap> = {
        website_url: out.website_url,
        instagram_url: out.instagram_url,
        facebook_url: out.facebook_url,
      };
      const filled = await fillMissingChannels(
        perplexityKey,
        { name, locationLine, category },
        missing(),
        siblings,
        serpContext,
      );
      for (const f of CHANNEL_FIELDS) {
        const u = filled[f];
        if (u) fill(f, u, "perplexity");
      }
    } else if (firecrawlKey) {
      const filled = await firecrawlSearchFill(firecrawlKey, name, city, missing());
      for (const f of CHANNEL_FIELDS) {
        const u = filled[f];
        if (u) fill(f, u, "search");
      }
    }
  }

  return assemble();
}

// ── Phone + email last-resort legs (NOT URLs; outside the channel set) ───────

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

// Normalise an email candidate to a lowercased, format-valid address or null.
function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
}

// Last-resort public phone lookup, used only when the Mesita seed + Google gave
// nothing. Grounded by the website + P2 SERP summary. null on anything
// uncertain (a wrong number is worse than a missing one).
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

// Last-resort public email lookup, same shape as phone. Prefers an address on
// the site's own domain. null on anything uncertain.
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
