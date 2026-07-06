// linklab — provider wrappers (Firecrawl v2, Perplexity Search/Agent/Sonar, Google Places).
// Best-effort: every call returns a safe empty value on failure so a strategy degrades
// instead of throwing. Optional on-disk response cache (keyed by request) is enabled ONLY
// when Deno.env LINKLAB_CACHE_DIR is set — the local benchmark runner sets it so that
// iterating on strategy logic doesn't re-bill Firecrawl/Perplexity/Google. The deployed
// EF leaves it unset and always hits the live APIs.

export type Keys = {
  firecrawl: string;
  perplexity: string;
  google: string;
};

export type SearchHit = { url: string; title: string; snippet: string };

// ---- call + cost accounting (read by the runner after a batch) --------------
export const meter = {
  firecrawlSearch: 0,
  firecrawlScrape: 0,
  perplexitySearch: 0,
  perplexityAgent: 0,
  perplexitySonar: 0,
  googleText: 0,
  googleDetails: 0,
  cacheHits: 0,
  reset() {
    const self = this as Record<string, unknown>;
    for (const k of Object.keys(self)) {
      if (typeof self[k] === "number") self[k] = 0;
    }
  },
};

// ---- cache ------------------------------------------------------------------
// Read lazily each call so import order can't strand the setting; the EF never
// sets LINKLAB_CACHE_DIR so this stays null there and every call hits the live API.
function cacheDir(): string | null {
  try {
    return Deno.env.get("LINKLAB_CACHE_DIR") ?? null;
  } catch {
    return null;
  }
}

async function sha(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

async function cached<T>(tag: string, req: unknown, run: () => Promise<T>): Promise<T> {
  const dir = cacheDir();
  if (!dir) return run();
  const key = `${tag}-${await sha(JSON.stringify(req))}`;
  const path = `${dir}/${key}.json`;
  try {
    const hit = await Deno.readTextFile(path);
    meter.cacheHits++;
    return JSON.parse(hit) as T;
  } catch {
    /* miss */
  }
  const out = await run();
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(out));
  } catch {
    /* ignore cache write errors */
  }
  return out;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 45000,
): Promise<unknown | null> {
  // one retry on 429 / 5xx
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        continue;
      }
      return null;
    } catch {
      // network/abort — retry once
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ---- Firecrawl v2 -----------------------------------------------------------
export function firecrawlSearch(
  keys: Keys,
  query: string,
  limit = 8,
  location?: string,
): Promise<SearchHit[]> {
  return cached("fc-search", { query, limit, location }, async () => {
    meter.firecrawlSearch++;
    const body: Record<string, unknown> = { query, limit, sources: [{ type: "web" }] };
    if (location) body.location = location;
    const d = (await fetchJson("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.firecrawl}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })) as { data?: { web?: unknown[] } | unknown[] } | null;
    if (!d) return [];
    const web = Array.isArray(d.data) ? d.data : (d.data?.web ?? []);
    return (web as Record<string, unknown>[])
      .filter((x) => typeof x?.url === "string")
      .map((x) => ({
        url: x.url as string,
        title: (x.title as string) ?? "",
        snippet: (x.description as string) ?? "",
      }));
  });
}

export function firecrawlScrapeLinks(
  keys: Keys,
  url: string,
): Promise<{ markdown: string; links: string[] } | null> {
  return cached("fc-scrape", { url }, async () => {
    meter.firecrawlScrape++;
    const d = (await fetchJson(
      "https://api.firecrawl.dev/v2/scrape",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${keys.firecrawl}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          formats: ["markdown", "links"],
          onlyMainContent: false, // footer is where social links live
        }),
      },
      30000,
    )) as { data?: { markdown?: string; links?: string[] } } | null;
    if (!d?.data) return null;
    return {
      markdown: d.data.markdown ?? "",
      links: Array.isArray(d.data.links) ? d.data.links : [],
    };
  });
}

// ---- Perplexity Search API (/search) — pure retrieval -----------------------
export function perplexitySearch(
  keys: Keys,
  query: string,
  maxResults = 10,
  country = "MX",
): Promise<SearchHit[]> {
  return cached("ppx-search", { query, maxResults, country }, async () => {
    meter.perplexitySearch++;
    const d = (await fetchJson("https://api.perplexity.ai/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.perplexity}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: maxResults, country }),
    })) as { results?: Record<string, unknown>[] } | null;
    if (!d?.results) return [];
    return d.results
      .filter((x) => typeof x?.url === "string")
      .map((x) => ({
        url: x.url as string,
        title: (x.title as string) ?? "",
        snippet: (x.snippet as string) ?? "",
      }));
  });
}

// ---- Perplexity Agent (/v1/agent, pro-search) — same contract as prod -------
const AGENT_DEFAULT_INSTRUCTIONS =
  "Resolve place URLs by anchoring on the official website and trusting the links the site itself points to. Output only JSON matching the schema. Never fabricate URLs; prefer null when unsure.";

export function perplexityAgent(
  keys: Keys,
  input: string,
  schema: unknown,
  opts: { instructions?: string; maxSteps?: number } = {},
): Promise<{ answer: Record<string, unknown>; hitUrls: string[] }> {
  return cached("ppx-agent", { input, schema, opts }, async () => {
    meter.perplexityAgent++;
    const d = (await fetchJson(
      "https://api.perplexity.ai/v1/agent",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${keys.perplexity}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input,
          preset: "pro-search",
          instructions: opts.instructions ?? AGENT_DEFAULT_INSTRUCTIONS,
          max_steps: opts.maxSteps ?? 8,
          response_format: { type: "json_schema", json_schema: { schema } },
        }),
      },
      90000,
    )) as {
      output?: { type?: string; content?: { text?: string; annotations?: { url?: unknown }[] }[] }[];
    } | null;
    const hitUrls: string[] = [];
    let text = "";
    for (const it of d?.output ?? []) {
      if (it?.type === "message" && Array.isArray(it.content)) {
        for (const c of it.content) {
          if (typeof c?.text === "string") text += c.text;
          for (const a of c?.annotations ?? []) {
            if (a && typeof a.url === "string") hitUrls.push(a.url);
          }
        }
      }
    }
    return { answer: safeJson(text), hitUrls };
  });
}

// ---- Perplexity Sonar (/v1/chat/completions) — structured judge -------------
export function perplexitySonar(
  keys: Keys,
  system: string,
  user: string,
  schema: unknown,
  opts: { model?: string; searchContextSize?: "low" | "medium" | "high" } = {},
): Promise<{ answer: Record<string, unknown>; searchResults: SearchHit[] }> {
  return cached("ppx-sonar", { system, user, schema, opts }, async () => {
    meter.perplexitySonar++;
    const d = (await fetchJson(
      "https://api.perplexity.ai/chat/completions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${keys.perplexity}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.model ?? "sonar-pro",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          web_search_options: { search_context_size: opts.searchContextSize ?? "medium" },
          response_format: {
            type: "json_schema",
            json_schema: { schema },
          },
        }),
      },
      60000,
    )) as {
      choices?: { message?: { content?: string } }[];
      search_results?: Record<string, unknown>[];
    } | null;
    const content = d?.choices?.[0]?.message?.content ?? "";
    const searchResults = (d?.search_results ?? [])
      .filter((x) => typeof x?.url === "string")
      .map((x) => ({
        url: x.url as string,
        title: (x.title as string) ?? "",
        snippet: (x.snippet as string) ?? "",
      }));
    return { answer: safeJson(content), searchResults };
  });
}

// ---- Google Places v1 -------------------------------------------------------
export type GooglePlace = {
  placeId: string;
  name: string;
  websiteUri: string | null;
  types: string[];
  formattedAddress: string | null;
  editorialSummary: string | null;
  googleMapsUri: string | null;
};

export function googleResolvePlace(
  keys: Keys,
  name: string,
  city: string,
): Promise<GooglePlace | null> {
  return cached("g-text", { name, city }, async () => {
    meter.googleText++;
    const d = (await fetchJson("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "X-Goog-Api-Key": keys.google,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.websiteUri,places.types,places.formattedAddress,places.editorialSummary,places.googleMapsUri",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ textQuery: `${name} ${city}`, languageCode: "es", regionCode: "MX" }),
    })) as { places?: Record<string, unknown>[] } | null;
    const p = d?.places?.[0];
    if (!p || typeof p.id !== "string") return null;
    return mapGooglePlace(p);
  });
}

function mapGooglePlace(p: Record<string, unknown>): GooglePlace {
  const disp = p.displayName as { text?: string } | undefined;
  const edit = p.editorialSummary as { text?: string } | undefined;
  return {
    placeId: p.id as string,
    name: disp?.text ?? "",
    websiteUri: (p.websiteUri as string) ?? null,
    types: Array.isArray(p.types) ? (p.types as string[]) : [],
    formattedAddress: (p.formattedAddress as string) ?? null,
    editorialSummary: edit?.text ?? null,
    googleMapsUri: (p.googleMapsUri as string) ?? null,
  };
}

// ---- util -------------------------------------------------------------------
export function safeJson(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // tolerate ```json fences / leading prose
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}
