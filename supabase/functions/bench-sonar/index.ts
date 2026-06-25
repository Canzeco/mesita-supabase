// Benchmark method 1/4 — Perplexity SONAR (web-grounded chat completion).
//
// One call: Sonar searches the web itself and returns a structured JSON
// object of the six links. This is the "bundled search + synthesis" option
// — the same product ADEA's editorial-summary node uses. We force JSON via
// response_format so output is directly scorable.
//
// Body:    { name: string, city?: string }
// Returns: { ok, method:"sonar", name, city, links, latency_ms, usage }
// Secret:  PERPLEXITY_KEY

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  EMPTY_LINKS,
  LINK_SCHEMA,
  linkPrompt,
  parseLinksJson,
} from "../_shared/bench-links.ts";

const PPLX_URL = "https://api.perplexity.ai/chat/completions";
const MODEL = "sonar";

type Body = { name?: string; city?: string };

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
    const r = await fetch(PPLX_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a precise data extractor. Output only the requested JSON object.",
          },
          { role: "user", content: linkPrompt(name, city) },
        ],
        response_format: { type: "json_schema", json_schema: { schema: LINK_SCHEMA } },
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    const latency_ms = Date.now() - started;
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 500);
      return json({
        ok: false,
        method: "sonar",
        name,
        city,
        links: { ...EMPTY_LINKS },
        error: `HTTP ${r.status}`,
        detail,
        latency_ms,
      });
    }
    const d = await r.json();
    const content: string = d?.choices?.[0]?.message?.content ?? "";
    const links = parseLinksJson(content);
    return json({
      ok: true,
      method: "sonar",
      name,
      city,
      links,
      latency_ms,
      usage: d?.usage ?? null,
    });
  } catch (e) {
    return json({
      ok: false,
      method: "sonar",
      name,
      city,
      links: { ...EMPTY_LINKS },
      error: String(e),
      latency_ms: Date.now() - started,
    });
  } finally {
    clearTimeout(timer);
  }
});
