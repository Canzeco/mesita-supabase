// Atlas channel URL discovery — Steps S4 (gather) + S5 (select). New model
// (MESITA-197): NO website-footer scraping. Link discovery gathers candidates
// with Firecrawl Search — PER SOURCE, count-controlled — then a SINGLE Perplexity
// Agent Y "Review & Select Links" pass reviews every candidate pool and picks the
// one official URL per field (or null). Phone + email ride the same Agent Y pass.
//
//   Phase 0  SEED     keep anything already supplied (Google/Mesita); freeze it.
//   S4       GATHER   one Firecrawl Search per still-missing source (per-source N
//                     from config); shape-validate + dedup into a candidate pool.
//   S5       SELECT   one Perplexity Agent Y pass reviews the pools + web context
//                     and returns the best URL per field + phone + email.
//                     Leniency: FALSE POSITIVES > FALSE NEGATIVES — keep a
//                     plausible official link over dropping a correct one; null
//                     ONLY when nothing in-hand is even plausibly this place's.
//
// Degraded leg (no Perplexity key): per-field Firecrawl Search, first shape-valid
// candidate wins (channels only; phone/email need the agent). Every URL — from the
// agent answer, its citations, or the candidate pool — passes validateFieldUrl
// (host + shape) before it is trusted.

import {
  canonicaliseUrl,
  domainOf,
  pickChannel,
  pickFacebook,
  pickInstagram,
  pickWebsite,
} from "./channels.ts";
import { firecrawlSearch } from "./firecrawl.ts";
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
type ChannelSource = "seed" | "search" | "perplexity";

// Per-source Firecrawl candidate counts (child C). Keyed to the active fields.
export type DiscoverCandidateCounts = Record<
  "website_url" | "instagram_url" | "facebook_url" | "opentable_url" | "uber_eats_url",
  number
>;

// Channels the discovery pass actively searches for. Yelp / TikTok / TripAdvisor
// are TEMPORARILY disabled — we don't discover them for the moment, so their
// columns stay null. To re-enable, add the three "*_url" entries back here; the
// field hints / pickChannel cases / query map below are left in place for that.
const CHANNEL_FIELDS: ChannelField[] = [
  "website_url",
  "instagram_url",
  "facebook_url",
  "opentable_url",
  "uber_eats_url",
];

// Per-field search term used to gather candidate URLs.
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

// Human-readable field spec for the Agent Y selection prompt.
const FIELD_SPEC: Record<ChannelField, string> = {
  website_url: "website_url: the place's own official website (its homepage domain).",
  instagram_url:
    "instagram_url: the place's Instagram profile (instagram.com/<handle>). A brand/franchise main account is acceptable.",
  facebook_url: "facebook_url: the place's official Facebook page.",
  opentable_url:
    "opentable_url: the canonical OpenTable restaurant page (opentable.com/r/… or a country domain). A brand page is acceptable.",
  uber_eats_url:
    "uber_eats_url: the canonical Uber Eats store page (ubereats.com/.../store/...).",
  tiktok_url:
    "tiktok_url: the place's TikTok profile (tiktok.com/@handle), never a single video.",
  tripadvisor_url:
    "tripadvisor_url: the place's TripAdvisor detail page (a Restaurant_Review / -d… page, not a city or category list).",
  yelp_url: "yelp_url: the place's Yelp business page (yelp.com/biz/<slug>).",
};

export type ResolvedChannels = ChannelMap & {
  // Phone + email now resolved in the SAME Agent Y pass (child B fold).
  phone: string | null;
  email: string | null;
  // Diagnostics only (orchestrator stuffs these into sources.discovery).
  via: Partial<Record<ChannelField | "phone" | "email", ChannelSource>>;
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
// canonical URL or null. The single gate every candidate (Agent answer, citation,
// candidate pool, degraded search) passes through before it is trusted.
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

// Minimal tokeniser for the one place we still name-match: website ranking.
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
// account for. Used only as a SOFT ranking signal now (footer harvest is gone, so
// a slightly-wrong website no longer poisons downstream) — we surface the best
// name-matched website candidate first so Agent Y anchors on it, but never hard-
// drop on it: FP > FN. "cosmosanpedro" → 1.0, "cosmoprofbeauty" → 0.33.
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

// ── S4 — per-source candidate gather (Firecrawl Search) ──────────────────────
// One Firecrawl Search per still-missing field, count-controlled by the per-source
// config knob. Shape-validate + dedup into a per-field candidate pool. Website
// candidates are name-ranked (best coverage first) so Agent Y anchors correctly.
async function gatherCandidates(
  firecrawlKey: string,
  name: string,
  city: string | null,
  fields: ChannelField[],
  counts: DiscoverCandidateCounts,
): Promise<Partial<Record<ChannelField, string[]>>> {
  const scope = [name, city ?? ""].map((s) => s.trim()).filter(Boolean).join(" ");
  const runs = await Promise.all(
    fields.map((f) => {
      const n = counts[f as keyof DiscoverCandidateCounts] ?? 5;
      if (n <= 0) return Promise.resolve<string[]>([]);
      return firecrawlSearch(firecrawlKey, `${scope} ${CHANNEL_SEARCH_TERM[f]}`, n);
    }),
  );
  const pools: Partial<Record<ChannelField, string[]>> = {};
  fields.forEach((f, i) => {
    const valid = dedup(runs[i])
      .map((u) => validateFieldUrl(f, u))
      .filter((u): u is string => !!u);
    if (f === "website_url") {
      valid.sort((a, b) =>
        hostNameCoverage(domainOf(b) ?? "", name) - hostNameCoverage(domainOf(a) ?? "", name)
      );
    }
    pools[f] = dedup(valid);
  });
  return pools;
}

// ── S5 — Agent Y "Review & Select Links" (single Perplexity Agent pass) ──────

const AGENT_Y_INSTRUCTIONS =
  "You are a meticulous reviewer that resolves a place's OWN official online " +
  "channels and public contact details. You are given candidate URLs found by " +
  "search plus web access. For each requested field, review the candidates and " +
  "the web, then return the single URL that is unmistakably THIS place's own " +
  "official presence, or null. Output ONLY strict JSON matching the schema. " +
  "Never fabricate a URL, number, or address.";

export async function selectChannels(
  key: string,
  place: { name: string; locationLine: string; category: string | null },
  want: Set<ChannelField>,
  candidates: Partial<Record<ChannelField, string[]>>,
  opts: {
    siblings?: Partial<ChannelMap>;
    serpContext?: string;
    wantPhone?: boolean;
    wantEmail?: boolean;
    website?: string | null;
  } = {},
): Promise<{ channels: Partial<ChannelMap>; phone: string | null; email: string | null }> {
  const fields = CHANNEL_FIELDS.filter((f) => want.has(f));
  const wantPhone = !!opts.wantPhone;
  const wantEmail = !!opts.wantEmail;
  if (!fields.length && !wantPhone && !wantEmail) {
    return { channels: {}, phone: null, email: null };
  }

  // Schema: every requested channel field + phone/email, each string-or-null.
  const properties: Record<string, { type: string[] }> = {};
  for (const f of fields) properties[f] = { type: ["string", "null"] };
  if (wantPhone) properties.phone = { type: ["string", "null"] };
  if (wantEmail) properties.email = { type: ["string", "null"] };
  const schema = { type: "object", properties };

  const candidateBlock = fields
    .map((f) => {
      const pool = (candidates[f] ?? []).slice(0, 10);
      return pool.length ? `${f} candidates:\n${pool.map((u) => `  - ${u}`).join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n");

  const siblings = opts.siblings ?? {};
  const sibLines = (["website_url", "instagram_url", "facebook_url"] as ChannelField[])
    .filter((f) => siblings[f])
    .map((f) => `- ${f}: ${siblings[f]}`)
    .join("\n");

  const askLines: string[] = fields.map((f) => `- ${FIELD_SPEC[f]}`);
  if (wantPhone) {
    askLines.push(
      "- phone: the place's official public phone number in international format (e.g. +52...).",
    );
  }
  if (wantEmail) {
    askLines.push("- email: the place's official public contact email (prefer one on its own domain).");
  }

  const igRule = want.has("instagram_url")
    ? "For instagram_url, prefer the venue's OWN account over a parent brand / group / " +
      "umbrella account spanning many locations. If SEVERAL official accounts exist for " +
      "this same venue (e.g. an older/secondary handle alongside a current one), pick the " +
      "FLAGSHIP: the account with the MOST FOLLOWERS and most recent activity — never an " +
      "older, secondary, regional, or lower-follower duplicate. "
    : "";

  const serpLine = (opts.serpContext ?? "").trim()
    ? `Background on the place (soft web context — never the source of a URL):\n${
      opts.serpContext!.trim().slice(0, 600)
    }\n\n`
    : "";

  const input =
    `Review and select the official channels + contact details for the place "${place.name}"` +
    (place.locationLine ? ` in ${place.locationLine}` : "") +
    (place.category ? ` (category: ${place.category})` : "") + ".\n\n" +
    serpLine +
    (sibLines
      ? `Already-known official channels (the missing ones almost always share the same brand handle / are linked from these — anchor on them):\n${sibLines}\n\n`
      : "") +
    (opts.website ? `Trust the links this official website itself lists: ${opts.website}\n\n` : "") +
    (candidateBlock ? `Candidate URLs found by search — review each and pick the correct one when present:\n${candidateBlock}\n\n` : "") +
    `Return strict JSON with ONLY these keys:\n${askLines.join("\n")}\n\n` +
    // The leniency flip (child B): FALSE POSITIVES > FALSE NEGATIVES.
    `Selection rule — LEAN TOWARD KEEPING: a plausible official link is better than ` +
    `dropping a correct one, so return a value whenever a candidate (or the web) ` +
    `plausibly IS this place's own channel. Return null for a field ONLY when NOTHING ` +
    `you can find is even plausibly this place's own presence. ${igRule}` +
    `Each URL must be the venue's OWN channel — NEVER a review site, ranking / "best of" ` +
    `list, guide, directory, aggregator, a single post/video, or a source you merely cited. ` +
    `A franchise / multi-location brand's MAIN account or page IS acceptable. ` +
    `Never invent a URL, number, or address.`;

  const res = await callPerplexityAgent(key, input, schema, {
    instructions: AGENT_Y_INSTRUCTIONS,
    maxSteps: 10,
  });
  if (!res) return { channels: {}, phone: null, email: null };

  const answer = res.answer;
  const hitUrls = res.hitUrls;
  const channels: Partial<ChannelMap> = {};
  for (const f of fields) {
    const fromAnswer = typeof answer[f] === "string" ? validateFieldUrl(f, answer[f] as string) : null;
    // FP > FN fallback: if the agent's own pick fails validation, fall back to a
    // cited URL, then to the best candidate we gathered — keeping a plausible link
    // beats dropping the field. All still shape-validated for the field.
    const valid = fromAnswer ??
      firstValidFromList(f, hitUrls) ??
      firstValidFromList(f, candidates[f] ?? []);
    if (valid) channels[f] = valid;
  }

  return {
    channels,
    phone: wantPhone ? normalisePhone(answer.phone) : null,
    email: wantEmail ? normaliseEmail(answer.email) : null,
  };
}

// ── resolveChannels — S4 gather → S5 Agent Y select entry point ──────────────
export async function resolveChannels(opts: {
  firecrawlKey?: string;
  perplexityKey?: string;
  name: string;
  city: string | null;
  locationLine: string;
  category: string | null;
  serpContext?: string;
  discoverCandidates: DiscoverCandidateCounts;
  have: {
    instagram: string | null;
    facebook: string | null;
    website: string | null;
    opentable: string | null;
    uberEats: string | null;
    tiktok?: string | null;
    tripadvisor?: string | null;
    yelp?: string | null;
    phone?: string | null;
    email?: string | null;
  };
}): Promise<ResolvedChannels> {
  const { firecrawlKey, perplexityKey, name, city, locationLine, category, serpContext } = opts;
  const counts = opts.discoverCandidates;

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
  let phone: string | null = opts.have.phone ?? null;
  let email: string | null = opts.have.email ?? null;
  const via: ResolvedChannels["via"] = {};
  const provenance: ResolvedChannels["provenance"] = {};
  for (const f of CHANNEL_FIELDS) {
    if (out[f]) {
      via[f] = "seed";
      provenance[f] = { source: "seed", url: out[f]! };
    }
  }
  if (phone) via.phone = "seed";
  if (email) via.email = "seed";

  const missing = (): Set<ChannelField> => new Set(CHANNEL_FIELDS.filter((f) => !out[f]));
  const fill = (field: ChannelField, url: string | null, source: ChannelSource): void => {
    if (!url || out[field]) return;
    out[field] = url;
    via[field] = source;
    provenance[field] = { source, url };
  };

  const assemble = (): ResolvedChannels => ({ ...out, phone, email, via, provenance });

  const wantPhone = !phone;
  const wantEmail = !email;
  const nothingToDo = missing().size === 0 && !wantPhone && !wantEmail;
  if (nothingToDo || (!firecrawlKey && !perplexityKey)) return assemble();

  // S4 — GATHER candidate pools (Firecrawl Search, per-source N). Best-effort.
  let pools: Partial<Record<ChannelField, string[]>> = {};
  if (firecrawlKey && missing().size > 0) {
    pools = await gatherCandidates(firecrawlKey, name, city, [...missing()], counts);
  }

  // S5 — SELECT with Agent Y (channels + phone + email in one pass). Degraded to
  // per-field Firecrawl first-hit when no Perplexity key (phone/email need the agent).
  if (perplexityKey) {
    const siblings: Partial<ChannelMap> = {
      website_url: out.website_url,
      instagram_url: out.instagram_url,
      facebook_url: out.facebook_url,
    };
    const sel = await selectChannels(
      perplexityKey,
      { name, locationLine, category },
      missing(),
      pools,
      { siblings, serpContext, wantPhone, wantEmail, website: out.website_url },
    );
    for (const f of CHANNEL_FIELDS) fill(f, sel.channels[f] ?? null, "perplexity");
    if (wantPhone && sel.phone) { phone = sel.phone; via.phone = "perplexity"; }
    if (wantEmail && sel.email) { email = sel.email; via.email = "perplexity"; }
  } else if (firecrawlKey) {
    // Degraded leg (no Perplexity key): no Agent Y to review, so take the first
    // shape-valid candidate per field from the pools we already gathered above
    // (reuse — never re-search: Firecrawl is metered budget).
    for (const f of CHANNEL_FIELDS) fill(f, (pools[f] ?? [])[0] ?? null, "search");
  }

  return assemble();
}

// ── phone + email normalisers (folded into Agent Y; used by selectChannels) ──

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
