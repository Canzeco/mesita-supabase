// Shared helpers for the link-discovery BENCHMARK edge functions
// (bench-sonar / bench-search / bench-agent / bench-firecrawl).
//
// The benchmark compares four methods on the same task: given a restaurant
// name + city, return its official links for six platforms. Two methods
// (sonar, agent) are LLM-grounded and return structured JSON directly; two
// (search, firecrawl) return raw ranked URLs that we bucket by domain here.
// Keeping the schema, prompt, JSON parsing, and URL bucketing in one place
// means all four functions are scored on identical field definitions.

export type BenchLinks = {
  google_maps: string | null;
  website: string | null;
  instagram: string | null;
  facebook: string | null;
  ubereats: string | null;
  opentable: string | null;
};

export const LINK_FIELDS: (keyof BenchLinks)[] = [
  "google_maps",
  "website",
  "instagram",
  "facebook",
  "ubereats",
  "opentable",
];

export const EMPTY_LINKS: BenchLinks = {
  google_maps: null,
  website: null,
  instagram: null,
  facebook: null,
  ubereats: null,
  opentable: null,
};

// JSON schema handed to the structured-output methods (sonar, agent).
export const LINK_SCHEMA = {
  type: "object",
  properties: {
    website: { type: ["string", "null"] },
    instagram: { type: ["string", "null"] },
    facebook: { type: ["string", "null"] },
    google_maps: { type: ["string", "null"] },
    ubereats: { type: ["string", "null"] },
    opentable: { type: ["string", "null"] },
  },
  required: [
    "website",
    "instagram",
    "facebook",
    "google_maps",
    "ubereats",
    "opentable",
  ],
  additionalProperties: false,
} as const;

// The instruction shared by the LLM-grounded methods. Deliberately strict:
// null is the correct answer when a link can't be confirmed, so the
// benchmark measures precision, not the model's willingness to guess.
export function linkPrompt(name: string, city: string): string {
  const where = city ? ` in ${city}, Mexico` : " in Mexico";
  return [
    `Find the official online links for the restaurant "${name}"${where}.`,
    `Return ONLY a JSON object with exactly these keys:`,
    `website, instagram, facebook, google_maps, ubereats, opentable.`,
    `Each value is the exact URL, or null if you cannot confidently confirm`,
    `it belongs to THIS specific venue (right name, right city).`,
    `Never guess. Do not use directory/aggregator pages (TripAdvisor, Yelp)`,
    `as the website. Output the JSON object and nothing else.`,
  ].join(" ");
}

// The raw-search queries used by the bucketing methods (search, firecrawl).
// One targeted query per platform gives raw search a fair shot at surfacing
// each link type, mirroring how you'd actually use a links-only search layer.
export function searchQueries(name: string, city: string): string[] {
  const v = `${name} ${city}`.trim();
  return [
    `${v} restaurante sitio web oficial`,
    `${v} instagram`,
    `${v} facebook`,
    `${v} google maps ubicacion`,
    `${v} uber eats opentable reservacion`,
  ];
}

// ---- URL bucketing for the raw-search methods -----------------------------

function host(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function has(h: string, frag: string): boolean {
  return h === frag || h.endsWith("." + frag) || h.includes(frag);
}

// Domains that are never the restaurant's own "website".
const NON_WEBSITE = [
  "instagram.com",
  "facebook.com",
  "fb.com",
  "fb.me",
  "ubereats.com",
  "opentable.com",
  "opentable.com.mx",
  "google.com",
  "google.com.mx",
  "maps.google.com",
  "maps.app.goo.gl",
  "g.page",
  "goo.gl",
  "tripadvisor.com",
  "tripadvisor.com.mx",
  "yelp.com",
  "yelp.com.mx",
  "rappi.com",
  "rappi.com.mx",
  "didifood.com",
  "foursquare.com",
  "wikipedia.org",
  "youtube.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "linktr.ee",
  "zomato.com",
  "doordash.com",
  "menudb",
  "restaurantguru.com",
  "sirved.com",
  "menu.com.mx",
  "wheream.com",
];

function isMaps(u: string, h: string): boolean {
  if (has(h, "maps.app.goo.gl") || has(h, "g.page") || h === "maps.google.com") {
    return true;
  }
  if (has(h, "google.") && u.includes("/maps")) return true;
  return false;
}

// Bucket a ranked list of URLs (best-first) into the six link fields.
// First match per field wins, mirroring "take the top relevant result".
export function extractLinks(urls: string[]): BenchLinks {
  const out: BenchLinks = { ...EMPTY_LINKS };
  for (const u of urls) {
    if (!u) continue;
    const h = host(u);
    if (!h) continue;
    if (!out.instagram && has(h, "instagram.com")) out.instagram = u;
    else if (!out.facebook && (has(h, "facebook.com") || has(h, "fb.com"))) {
      out.facebook = u;
    } else if (!out.ubereats && has(h, "ubereats.com")) out.ubereats = u;
    else if (!out.opentable && has(h, "opentable.com")) out.opentable = u;
    else if (!out.google_maps && isMaps(u, h)) out.google_maps = u;
  }
  // Website = first URL whose host is not a known social/aggregator domain.
  for (const u of urls) {
    const h = host(u);
    if (!h) continue;
    if (NON_WEBSITE.some((d) => has(h, d))) continue;
    out.website = u;
    break;
  }
  return out;
}

// Pull a BenchLinks object out of a model's text reply. Handles a bare JSON
// object, or JSON wrapped in prose / code fences.
export function parseLinksJson(text: string): BenchLinks {
  const out: BenchLinks = { ...EMPTY_LINKS };
  if (!text) return out;
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        obj = null;
      }
    }
  }
  if (obj && typeof obj === "object") {
    for (const k of LINK_FIELDS) {
      const v = obj[k];
      out[k] = typeof v === "string" && v.trim() ? v.trim() : null;
    }
  }
  return out;
}
