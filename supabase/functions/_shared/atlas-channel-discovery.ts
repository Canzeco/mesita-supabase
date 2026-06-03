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

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_MODEL = "sonar-pro";
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

// ── Discovery + parsing helpers ─────────────────────────────────────────────

type Channels = {
  instagram_url: string | null;
  facebook_url: string | null;
  website_url: string | null;
};

type DiscoveryField = "website" | "instagram" | "facebook" | "opentable" | "ubereats";
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
};

const PROVIDER_PRIOR: Record<DiscoveryField, Record<CandidateProvider, number>> = {
  website: { google: 1.2, seed: 0.8, firecrawl: 0.7, perplexity: 0.45, website_footer: 0.65 },
  instagram: { google: 1.0, seed: 0.7, firecrawl: 0.85, perplexity: 0.35, website_footer: 1.1 },
  facebook: { google: 1.0, seed: 0.7, firecrawl: 0.75, perplexity: 0.35, website_footer: 1.0 },
  opentable: { google: 0.6, seed: 0.7, firecrawl: 0.9, perplexity: 0.55, website_footer: 0.9 },
  ubereats: { google: 0.55, seed: 0.7, firecrawl: 0.28, perplexity: 0.42, website_footer: 0.5 },
};

const FIELD_THRESHOLD: Record<DiscoveryField, number> = {
  // Tolerance policy:
  // - stricter (less false positives): website/facebook/opentable/ubereats
  // - softer (prefer finding a plausible handle): instagram
  website: 0.5,
  instagram: 0.48,
  facebook: 0.54,
  opentable: 0.54,
  ubereats: 0.38,
};

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
  const hit = pickChannel([canon], "uber_eats_url");
  if (!hit) return null;
  try {
    if (!new URL(hit).pathname.toLowerCase().includes("/store/")) return null;
  } catch {
    return null;
  }
  return hit;
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
  return Math.round(score * 1000) / 1000;
}

function selectBestCandidate(
  field: DiscoveryField,
  candidates: DiscoveryCandidate[],
  ctx: DiscoveryContext,
): DiscoverySelection | null {
  if (!candidates.length) return null;
  const bestByUrl = new Map<string, DiscoverySelection>();
  for (const c of candidates) {
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

function isFallbackProvider(field: DiscoveryField, provider: CandidateProvider): boolean {
  if (field === "website") return !["google", "firecrawl"].includes(provider);
  if (field === "instagram" || field === "facebook") {
    return !["google", "firecrawl", "website_footer"].includes(provider);
  }
  if (field === "opentable") return !["seed", "firecrawl", "website_footer"].includes(provider);
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
  have: {
    instagram: string | null;
    facebook: string | null;
    website: string | null;
    opentable: string | null;
    uberEats: string | null;
  };
}): Promise<
  Channels & {
    opentable_url: string | null;
    uber_eats_url: string | null;
    via: Record<string, string>;
    provenance: Record<DiscoveryField, FieldProvenance>;
  }
> {
  let instagram = opts.have.instagram;
  let facebook = opts.have.facebook;
  let website = opts.have.website;
  let opentable = opts.have.opentable;
  let uberEats = opts.have.uberEats;
  const wantDelivery = opts.resolveReservationDelivery === true;
  const via: Record<string, string> = {};
  if (instagram) via.instagram = "google";
  if (facebook) via.facebook = "google";
  if (website) via.website = "google";
  if (opentable) via.opentable = "seed";
  if (uberEats) via.ubereats = "seed";
  const ctx = buildDiscoveryContext(opts.name, opts.city, opts.locationLine);
  const pool: Record<DiscoveryField, DiscoveryCandidate[]> = {
    website: [],
    instagram: [],
    facebook: [],
    opentable: [],
    ubereats: [],
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
  };
  const applySelection = (field: DiscoveryField, sel: DiscoverySelection | null): void => {
    provenance[field].candidate_count = pool[field].length;
    if (!sel) return;
    if (field === "website" && !website) website = sel.url;
    if (field === "instagram" && !instagram) instagram = sel.url;
    if (field === "facebook" && !facebook) facebook = sel.url;
    if (field === "opentable" && !opentable) opentable = sel.url;
    if (field === "ubereats" && !uberEats) uberEats = sel.url;
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
    const needOpenTable = wantDelivery && !opentable;
    const needUberEats = wantDelivery && !uberEats;
    const [igHits, fbHits, webHits, otHits, ueHits] = await Promise.all([
      instagram ? Promise.resolve<string[]>([]) : searchMany(igQueries),
      facebook ? Promise.resolve<string[]>([]) : searchMany(fbQueries),
      website ? Promise.resolve<string[]>([]) : searchMany(webQueries),
      needOpenTable ? searchMany(otQueries) : Promise.resolve<string[]>([]),
      needUberEats ? searchMany(ueQueries) : Promise.resolve<string[]>([]),
    ]);
    addDiscoveryCandidates(pool, "instagram", igHits, "firecrawl", "search");
    addDiscoveryCandidates(pool, "facebook", fbHits, "firecrawl", "search");
    addDiscoveryCandidates(pool, "website", webHits, "firecrawl", "search");
    if (needOpenTable) addDiscoveryCandidates(pool, "opentable", otHits, "firecrawl", "search");
    if (needUberEats) addDiscoveryCandidates(pool, "ubereats", ueHits, "firecrawl", "search");
    if (!website) applySelection("website", selectBestCandidate("website", pool.website, ctx));

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
      }
    }
    if (!instagram) applySelection("instagram", selectBestCandidate("instagram", pool.instagram, ctx));
    if (!facebook) applySelection("facebook", selectBestCandidate("facebook", pool.facebook, ctx));
    if (needOpenTable && !opentable) {
      applySelection("opentable", selectBestCandidate("opentable", pool.opentable, ctx));
    }
    if (needUberEats && !uberEats && !opts.perplexityKey) {
      applySelection("ubereats", selectBestCandidate("ubereats", pool.ubereats, ctx));
    }
  }

  // 3. Perplexity fallback/cross-check.
  // Run socials + delivery lookups in parallel when both are needed.
  const needPerplexityChannels =
    !!opts.perplexityKey && (!instagram || !facebook || !website || !!opts.firecrawlKey);
  const needPerplexityDelivery =
    !!opts.perplexityKey && wantDelivery && (!opentable || !uberEats);

  if (needPerplexityChannels || needPerplexityDelivery) {
    const [pp, dd] = await Promise.all([
      needPerplexityChannels
        ? discoverChannelsPerplexity(
            opts.perplexityKey!,
            opts.name,
            opts.locationLine,
            opts.category,
          )
        : Promise.resolve(null),
      needPerplexityDelivery
        ? discoverDeliveryPerplexity(
            opts.perplexityKey!,
            opts.name,
            opts.locationLine,
            opts.category,
          )
        : Promise.resolve(null),
    ]);

    if (pp) {
      if (pp.instagram_url) {
        addDiscoveryCandidates(pool, "instagram", [pp.instagram_url], "perplexity", "json_or_citations");
      }
      if (pp.facebook_url) {
        addDiscoveryCandidates(pool, "facebook", [pp.facebook_url], "perplexity", "json_or_citations");
      }
      if (pp.website_url) {
        addDiscoveryCandidates(pool, "website", [pp.website_url], "perplexity", "json_or_citations");
      }
    }

    if (dd) {
      if (dd.opentable_url) {
        addDiscoveryCandidates(pool, "opentable", [dd.opentable_url], "perplexity", "json_or_citations");
      }
      if (dd.uber_eats_url) {
        addDiscoveryCandidates(pool, "ubereats", [dd.uber_eats_url], "perplexity", "json_or_citations");
      }
    }

    if (!website) applySelection("website", selectBestCandidate("website", pool.website, ctx));
    if (!instagram) applySelection("instagram", selectBestCandidate("instagram", pool.instagram, ctx));
    if (!facebook) applySelection("facebook", selectBestCandidate("facebook", pool.facebook, ctx));
    if (wantDelivery && !opentable) {
      applySelection("opentable", selectBestCandidate("opentable", pool.opentable, ctx));
    }
    if (wantDelivery && !uberEats) {
      applySelection("ubereats", selectBestCandidate("ubereats", pool.ubereats, ctx));
    }
  } else if (wantDelivery && !uberEats) {
    applySelection("ubereats", selectBestCandidate("ubereats", pool.ubereats, ctx));
  }

  for (const field of ["website", "instagram", "facebook", "opentable", "ubereats"] as DiscoveryField[]) {
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
    via,
    provenance,
  };
}


// Perplexity fallback: resolve channel URLs from search. An LLM, so every URL
// it returns is host-validated before we trust it.
async function discoverChannelsPerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
): Promise<Channels | null> {
  const prompt =
    `Find these links for venue "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") +
    `. Return strict JSON with instagram_url, facebook_url, website_url.\n` +
    `Confidence policy:\n` +
    `- website_url and facebook_url: stricter (avoid false positives). If unsure, use null.\n` +
    `- instagram_url: softer (avoid false negatives). Return best plausible official profile; null only if no good lead.\n` +
    `Use simple web evidence and never invent URLs.`;
  try {
    const r = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Resolve venue URLs from web search and output only JSON matching schema. Keep website/facebook conservative (prefer null when uncertain). For Instagram, return best plausible official profile to reduce misses. Brand-level account/site is acceptable for chains. Never fabricate URLs.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { schema: CHANNELS_SCHEMA },
        },
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      citations?: unknown[];
      search_results?: { url?: unknown }[];
    };
    // sonar-pro answers on two channels: the JSON content (its considered
    // answer) and the raw web hits it actually consulted (citations +
    // search_results). The model is conservative and frequently returns null
    // for a social profile it nonetheless surfaced in its sources — so when the
    // JSON is empty we mine those hit URLs. pickInstagram/pickFacebook are
    // host-locked to instagram.com/facebook.com, and the hits are specific to
    // THIS venue's query, so a social URL among them is almost certainly the
    // venue's. (Website is left JSON-only: a citation could be any news/blog
    // domain that pickWebsite can't tell apart from the real site.)
    const hitUrls: string[] = [];
    for (const c of data.citations ?? []) {
      if (typeof c === "string") hitUrls.push(c);
    }
    for (const s of data.search_results ?? []) {
      if (s && typeof s.url === "string") hitUrls.push(s.url);
    }
    const answer = (safeParseJson(data.choices?.[0]?.message?.content ?? "") as
      | { instagram_url?: unknown; facebook_url?: unknown; website_url?: unknown }
      | null) ?? {};
    const instagram_url =
      pickInstagram([String(answer.instagram_url ?? "")]) ??
      validHost(answer.instagram_url, ["instagram.com"]) ??
      pickInstagram(hitUrls);
    const facebook_url =
      facebookPageFromUrl(String(answer.facebook_url ?? "")) ??
      validHost(answer.facebook_url, ["facebook.com", "fb.com"]) ??
      pickFacebook(hitUrls);
    const website_url = validHost(answer.website_url, null);
    if (!instagram_url && !facebook_url && !website_url) return null;
    return { instagram_url, facebook_url, website_url };
  } catch {
    return null;
  }
}


// Perplexity fallback for the tier-3 directory links (OpenTable reservations +
// UberEats delivery). Same host-locked discipline as the social fallback:
// every candidate — whether from the JSON answer or the mined citations — must
// resolve to the right host via pickChannel before we trust it.
async function discoverDeliveryPerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
): Promise<{ opentable_url: string | null; uber_eats_url: string | null } | null> {
  const prompt =
    `Find reservation and delivery links for "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") +
    `. takes reservations and delivery. Return strict JSON with:\n` +
    `- opentable_url: the canonical OpenTable restaurant page (opentable.com or ` +
    `a country domain like opentable.com.mx). For a chain, the specific ` +
    `location's page is best, but the brand page is acceptable. null if none.\n` +
    `- uber_eats_url: the canonical Uber Eats store page (ubereats.com). For a ` +
    `chain, the specific store is best, the brand page acceptable. null if none.\n` +
    `For both links be conservative (low false positives). If unsure, use null. Never invent a URL.`;
  try {
    const r = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Resolve OpenTable and Uber Eats URLs from web search. Output only schema JSON. Be conservative: if uncertain, use null. Specific location is best; brand-level acceptable. Never fabricate URLs.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { schema: DELIVERY_CHANNELS_SCHEMA },
        },
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      citations?: unknown[];
      search_results?: { url?: unknown }[];
    };
    const hitUrls: string[] = [];
    for (const c of data.citations ?? []) {
      if (typeof c === "string") hitUrls.push(c);
    }
    for (const s of data.search_results ?? []) {
      if (s && typeof s.url === "string") hitUrls.push(s.url);
    }
    const answer = (safeParseJson(data.choices?.[0]?.message?.content ?? "") as
      | { opentable_url?: unknown; uber_eats_url?: unknown }
      | null) ?? {};
    const opentable_url =
      pickChannel([String(answer.opentable_url ?? "")], "opentable_url") ??
      pickChannel(hitUrls, "opentable_url");
    const uber_eats_url =
      pickChannel([String(answer.uber_eats_url ?? "")], "uber_eats_url") ??
      pickChannel(hitUrls, "uber_eats_url");
    if (!opentable_url && !uber_eats_url) return null;
    return { opentable_url, uber_eats_url };
  } catch {
    return null;
  }
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
