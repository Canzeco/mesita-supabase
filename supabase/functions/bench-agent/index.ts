// Benchmark method 3/4 — Perplexity AGENT API (autonomous multi-step).
//
// We hand the Agent the same links-only task and let it decide how many
// searches / fetches to run. Pinned to the "fast-search" preset (cheapest
// agent tier) so the test reflects a sane production config, not a runaway
// deep-research pass. Output is forced to the shared JSON schema; we also
// fall back to parsing JSON out of the message text if the structured
// channel comes back empty.
//
// Body:    { name: string, city?: string }
// Returns: { ok, method:"agent", name, city, links, latency_ms, usage }
// Secret:  PERPLEXITY_KEY

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  EMPTY_LINKS,
  LINK_SCHEMA,
  linkPrompt,
  parseLinksJson,
} from "../_shared/bench-links.ts";

const AGENT_URL = "https://api.perplexity.ai/v1/agent";
const PRESET = "fast-search";

type Body = { name?: string; city?: string };

type AgentContent = { type?: string; text?: string };
type AgentOutputItem = { type?: string; content?: AgentContent[] };
type AgentResponse = {
  output?: AgentOutputItem[];
  usage?: unknown;
  status?: string;
  error?: { message?: string };
};

function textFromOutput(out: AgentOutputItem[]): string {
  let text = "";
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (typeof c?.text === "string") text += c.text;
      }
    }
  }
  return text;
}

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
  // Agent runs several searches; give it more headroom than the one-shot
  // methods but still bound it so a hung run can't stall the function.
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const r = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: linkPrompt(name, city),
        preset: PRESET,
        response_format: {
          type: "json_schema",
          json_schema: { schema: LINK_SCHEMA },
        },
      }),
      signal: ctrl.signal,
    });
    const latency_ms = Date.now() - started;
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 500);
      return json({
        ok: false,
        method: "agent",
        name,
        city,
        links: { ...EMPTY_LINKS },
        error: `HTTP ${r.status}`,
        detail,
        latency_ms,
      });
    }
    const d = (await r.json()) as AgentResponse;
    const text = textFromOutput(d.output ?? []);
    const links = parseLinksJson(text);
    return json({
      ok: true,
      method: "agent",
      name,
      city,
      links,
      latency_ms,
      usage: d.usage ?? null,
      status: d.status ?? null,
    });
  } catch (e) {
    return json({
      ok: false,
      method: "agent",
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
