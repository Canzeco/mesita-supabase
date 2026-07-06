// Atlas channel URL discovery — Step S3, WEBSITE-FIRST: a place's own site footer
// is the highest-precision source of its official channels, so we anchor on the
// website, classify its outbound links, then make ONE Perplexity Sonar call — P3,
// the niche gap-filler — to fill only what's still missing. Every URL is host + shape
// validated before it's trusted. No scoring engine, no multi-pass FP/FN review.
//
//   Phase 0  SEED      keep anything already supplied (Google/Mesita); freeze it.
//   Phase 1  ANCHOR    if no website, one Firecrawl search to find it.
//   Phase 2  FOOTER    scrape the site, classifyLinks() the footer, validate.
//   Phase 3  FILL      one Perplexity Sonar (sonar-pro) structured judge for fields
//                      still missing, grounded on Firecrawl candidate URLs + an
//                      own-account-over-group rule. Benchmarked winner (linklab
//                      strategy C) over the older Agent fill. (no Perplexity key →
//                      degraded per-field Firecrawl search)
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
import { callPerplexityChat } from "./perplexity-chat.ts";
import { dedup, safeParseJson } from "./parse-utils.ts";

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

// Channels the discovery pass actively searches for (footer harvest, Perplexity
// fill, Firecrawl fill all iterate this list). Yelp / TikTok / TripAdvisor are
// TEMPORARILY disabled — we don't discover them for the moment, so their columns
// stay null. To re-enable, just add the three "*_url" entries back here; the
// field hints / pickChannel cases / query map below are left in place for that.
const CHANNEL_FIELDS: ChannelField[] = [
  "website_url",
  "instagram_url",
  "facebook_url",
  "opentable_url",
  "uber_eats_url",
];

// Per-field search term used to gather candidate URLs (Phase 3 grounding + the
// no-Perplexity degraded leg).
const CHANNEL_SEARCH_TERM: Record<ChannelField, string> = {
  website_url: "official website",
  instagram_url: "instagram",
  facebook_url: "facebook",
  opentable_url: "opentable",
  uber_eats_url: "uber eats",
  tiktok_url: "tiktok",
  tripadvisor_url: "tripadvisor",
  yelp_url: "yelp",
};

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

// Main registrable label of a host (label before the TLD): "cosmoprofbeauty"
// for both "cosmoprofbeauty.com" and "stores.cosmoprofbeauty.com".
function mainDomainLabel(host: string): string {
  const parts = host.replace(/^www\./, "").toLowerCase().split(".").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? "");
}

// Fraction of a candidate host's main-label letters that the place-name tokens
// account for. A bare substring match is too loose — "cosmo" is inside the
// unrelated "cosmoprofbeauty" — so we require the name to COVER a strong majority
// of the label. Rejects cosmoprofbeauty (0.33) while accepting cosmosanpedro
// (1.0) or cosmosp (0.71).
function hostNameCoverage(host: string, name: string): number {
  const letters = mainDomainLabel(host).replace(/[^a-z0-9]/g, "");
  const toks = nameTokens(name);
  if (!letters || !toks.length) return 0;
  let covered = 0;
  let rest = letters;
  for (const t of [...toks].sort((a, b) => b.length - a.length)) {
    const idx = rest.indexOf(t);
    if (idx !== -1) {
      covered += t.length;
      rest = rest.slice(0, idx) + rest.slice(idx + t.length);
    }
  }
  return covered / letters.length;
}

// ── Phase 1 — anchor the official website ────────────────────────────────────
// One Firecrawl search. Keep a result whose host is strongly name-matched
// (guards against harvesting a DIFFERENT business's footer); none → no website.
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
  // Require the candidate host's main label to be strongly EXPLAINED by the place
  // name. A loose substring match ("cosmo" ⊂ "cosmoprofbeauty") once resolved
  // "Cosmo San Pedro" to a beauty-supply store. No confident match → return null
  // (no website) rather than guessing sites[0]: a wrong site poisons footer
  // harvest + website images downstream.
  const named = sites.find((u) => hostNameCoverage(domainOf(u) ?? "", name) >= 0.55);
  return named ?? null;
}

// ── Phase 2 — harvest the website footer ─────────────────────────────────────
// Scrape the homepage with onlyMainContent:false (footer links live outside main
// content), classify the outbound links, shape-validate each wanted hit. Footer
// links are trusted on host+shape alone — they are the links the place itself
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

// ── Phase 3 — one Perplexity Sonar call to fill what's still missing ─────────
// A single sonar-pro structured judge, web-grounded AND fed Firecrawl candidate
// URLs, picks the official URL for each still-missing field. The schema is built
// dynamically so it's only asked for the missing fields; already-resolved siblings
// anchor the prompt. Every returned URL (JSON answer, then cited URLs, then the
// Firecrawl candidates) is host + shape validated. Benchmarked winner (linklab
// strategy C) over the older Agent fill. Also reused by S4 (enrich-instagram.ts)
// to re-find an Instagram handle. Best-effort → {}.
const FILL_FIELD_SPEC: Record<ChannelField, string> = {
  website_url: "website_url: the place's official website. null if none.",
  instagram_url:
    "instagram_url: the place's Instagram profile (instagram.com/<handle>). A brand/franchise main account is acceptable. null if none.",
  facebook_url: "facebook_url: the place's official Facebook page. null if none.",
  opentable_url:
    "opentable_url: the canonical OpenTable restaurant page (opentable.com/r/… or a country domain). Brand page acceptable. null if not on OpenTable.",
  uber_eats_url:
    "uber_eats_url: the canonical Uber Eats store page (ubereats.com/.../store/...). null if not on Uber Eats.",
  tiktok_url:
    "tiktok_url: the place's TikTok profile (tiktok.com/@handle), never a single video. null if none.",
  tripadvisor_url:
    "tripadvisor_url: the place's TripAdvisor detail page (a Restaurant_Review / -d… page, not a city or category list). null if none.",
  yelp_url: "yelp_url: the place's Yelp business page (yelp.com/biz/<slug>). null if none.",
};

function serpGroundingLine(serpContext?: string): string {
  const s = (serpContext ?? "").trim();
  if (!s) return "";
  return `Background on the place (web-grounded, soft context — do not treat as the source of any URL):\n${s.slice(0, 600)}\n\n`;
}

export async function fillMissingChannels(
  key: string,
  place: { name: string; locationLine: string; category: string | null },
  want: Set<ChannelField>,
  siblings: Partial<ChannelMap> = {},
  serpContext?: string,
  firecrawlKey?: string,
): Promise<Partial<ChannelMap>> {
  const fields = CHANNEL_FIELDS.filter((f) => want.has(f));
  if (!fields.length) return {};

  const properties: Record<string, { type: string[] }> = {};
  for (const f of fields) properties[f] = { type: ["string", "null"] };
  const schema = { type: "object", properties };

  // Ground the judge on real candidate URLs (one Firecrawl search per missing
  // field) so it picks from what exists instead of hallucinating. Kept per-field
  // too, as a validated fallback when the model's own answer is null.
  const perField: Partial<Record<ChannelField, string[]>> = {};
  if (firecrawlKey) {
    const runs = await Promise.all(
      fields.map((f) => firecrawlSearch(firecrawlKey, `${place.name} ${CHANNEL_SEARCH_TERM[f]}`, 6)),
    );
    fields.forEach((f, i) => (perField[f] = dedup(runs[i])));
  }
  const candidatePool = dedup(fields.flatMap((f) => perField[f] ?? [])).slice(0, 30);
  const candidateBlock = candidatePool.length
    ? `Candidate URLs found by search (prefer one of these when it is correct; ignore unrelated ones):\n${candidatePool.join("\n")}\n\n`
    : "";

  const sibLines = (["website_url", "instagram_url", "facebook_url"] as ChannelField[])
    .filter((f) => siblings[f])
    .map((f) => `- ${f}: ${siblings[f]}`)
    .join("\n");
  const askLines = fields.map((f) => `- ${FILL_FIELD_SPEC[f]}`).join("\n");
  // Own-account-over-group rule — the linklab R2 win for Instagram precision.
  const igRule = want.has("instagram_url")
    ? `For instagram_url, prefer the venue's OWN account over a parent brand / group / umbrella ` +
      `account that spans many locations; if several official accounts exist, prefer the primary ` +
      `(most-active) one. `
    : "";

  const prompt =
    `Find the official online channels for the place "${place.name}"` +
    (place.locationLine ? ` in ${place.locationLine}` : "") +
    (place.category ? ` (category: ${place.category})` : "") + ".\n" +
    serpGroundingLine(serpContext) +
    (sibLines
      ? `Anchor on these already-known official channels (the missing ones almost always share the same brand handle / are linked from these):\n${sibLines}\n\n`
      : "") +
    candidateBlock +
    `Find the official WEBSITE first and trust the channels the site itself links to. ${igRule}` +
    `Return strict JSON with ONLY these keys (null any you cannot confirm belongs to THIS place):\n${askLines}\n` +
    `A franchise / multi-location brand's MAIN account or page is acceptable. ` +
    `Be conservative — prefer null over a guess. Never invent a URL.`;

  const res = await callPerplexityChat(
    key,
    [
      {
        role: "system",
        content:
          "You resolve a place's official channel URLs from web search plus a candidate list. " +
          "Return ONLY strict JSON with the requested keys. Never invent a URL; prefer null over a wrong guess.",
      },
      { role: "user", content: prompt },
    ],
    { responseFormat: { type: "json_schema", json_schema: { schema } }, returnRelated: false },
  );
  if (!res) return {};
  const answer = (safeParseJson(res.text) as Record<string, unknown> | null) ?? {};
  const hitUrls = res.citations;
  const out: Partial<ChannelMap> = {};
  for (const f of fields) {
    const fromAnswer = typeof answer[f] === "string"
      ? validateFieldUrl(f, answer[f] as string)
      : null;
    const valid = fromAnswer ??
      firstValidFromList(f, hitUrls) ??
      firstValidFromList(f, perField[f] ?? []);
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
  const fields = CHANNEL_FIELDS.filter((f) => want.has(f));
  const runs = await Promise.all(
    fields.map((f) => firecrawlSearch(firecrawlKey, `${scope} ${CHANNEL_SEARCH_TERM[f]}`, 6)),
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

  // Phase 2 — HARVEST the footer (highest precision: the place's own links).
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
        firecrawlKey,
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
    `Find the official public phone number for the place "${name}"` +
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
    `Find the official public contact email for the place "${name}"` +
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
