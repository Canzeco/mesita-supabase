// Benchmark method 4/4 — FIRECRAWL SEARCH (raw ranked results).
//
// The incumbent discovery layer. We reuse the existing _shared/firecrawl.ts
// helper (same one ADEA uses), fire one targeted query per platform, and
// bucket the returned URLs by domain with the same extractLinks used by the
// Perplexity Search method — so the two raw-search approaches are scored
// identically and only the underlying search engine differs.
//
// Body:    { name: string, city?: string }
// Returns: { ok, method:"firecrawl", name, city, links, candidates, latency_ms }
// Secret:  FIRECRAWL_KEY

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { firecrawlSearch } from "../_shared/firecrawl.ts";
import {
  EMPTY_LINKS,
  extractLinks,
  searchQueries,
} from "../_shared/bench-links.ts";

type Body = { name?: string; city?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const key = Deno.env.get("FIRECRAWL_KEY");
  if (!key) return json({ ok: false, error: "FIRECRAWL_KEY not set" }, 500);

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const name = (bodyRes.body.name ?? "").trim();
  const city = (bodyRes.body.city ?? "").trim();
  if (!name) return json({ ok: false, error: "name is required" }, 400);

  const started = Date.now();
  try {
    // firecrawlSearch is best-effort and returns [] on any failure. Run one
    // query per platform and merge the URL lists, preserving rank order.
    const queries = searchQueries(name, city);
    const lists = await Promise.all(
      queries.map((q) => firecrawlSearch(key, q, 6)),
    );
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
      for (const u of list) {
        if (u && !seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
    }
    const latency_ms = Date.now() - started;
    const links = extractLinks(urls);
    return json({
      ok: true,
      method: "firecrawl",
      name,
      city,
      links,
      candidates: urls.slice(0, 25),
      latency_ms,
    });
  } catch (e) {
    return json({
      ok: false,
      method: "firecrawl",
      name,
      city,
      links: { ...EMPTY_LINKS },
      candidates: [],
      error: String(e),
      latency_ms: Date.now() - started,
    });
  }
});
