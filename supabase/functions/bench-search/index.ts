// Benchmark method 2/4 — Perplexity SEARCH API (raw ranked results).
//
// No LLM. We fire one targeted query per platform, collect the ranked
// result URLs, and bucket them by domain ourselves (extractLinks). This is
// the apples-to-apples analog of Firecrawl Search: a links-only discovery
// layer where the picking logic is ours, not the model's.
//
// Body:    { name: string, city?: string }
// Returns: { ok, method:"search", name, city, links, candidates, latency_ms }
// Secret:  PERPLEXITY_KEY

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  EMPTY_LINKS,
  extractLinks,
  searchQueries,
} from "../_shared/bench-links.ts";

const SEARCH_URL = "https://api.perplexity.ai/search";

type Body = { name?: string; city?: string };

type SearchResult = { url?: string };
type SearchResponse = { results?: SearchResult[] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const key = Deno.env.get("PERPLEXITY_KEY");
  if (!key) return json({ ok: false, error: "PERPLEXITY_KEY not set" }, 500);

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const name = (bodyRes.body.name ?? "").trim();
  const city = (bodyRes.body.city ?? "").trim();
  if (!name) return json({ ok: false, error: "name is required" }, 400);

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      // The Search API accepts an array of queries; results come back merged
      // best-first in a single results[] array.
      body: JSON.stringify({
        query: searchQueries(name, city),
        max_results: 10,
      }),
      signal: ctrl.signal,
    });
    const latency_ms = Date.now() - started;
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 500);
      return json({
        ok: false,
        method: "search",
        name,
        city,
        links: { ...EMPTY_LINKS },
        candidates: [],
        error: `HTTP ${r.status}`,
        detail,
        latency_ms,
      });
    }
    const d = (await r.json()) as SearchResponse;
    const urls = (d.results ?? [])
      .map((x) => x?.url ?? "")
      .filter(Boolean);
    const links = extractLinks(urls);
    return json({
      ok: true,
      method: "search",
      name,
      city,
      links,
      candidates: urls.slice(0, 25),
      latency_ms,
    });
  } catch (e) {
    return json({
      ok: false,
      method: "search",
      name,
      city,
      links: { ...EMPTY_LINKS },
      candidates: [],
      error: String(e),
      latency_ms: Date.now() - started,
    });
  } finally {
    clearTimeout(timer);
  }
});
