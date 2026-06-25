// Atlas SERP synthesis (Agent X). A fast Perplexity research pass that returns a
// SHORT web-grounded editorial blurb (vibe, reputation, signature dishes/drinks,
// notable press) used as SOFT context only — never as an authoritative source of
// facts, ratings, or prices. Runs as Tier 2 (after Google, before link
// discovery): its summary is threaded into Agent Y's discovery prompts AND into
// the final Cognition synthesis as extra grounding.
//
// Same Perplexity Agent runtime + preset as atlas-channel-discovery.ts (Agent Y)
// so the two stay on one client contract.

import { safeParseJson } from "./parse-utils.ts";

const PERPLEXITY_AGENT_URL = "https://api.perplexity.ai/v1/agent";
const PERPLEXITY_AGENT_PRESET = "pro-search";

const SERP_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: ["string", "null"] },
  },
} as const;

// Web-grounded editorial color for a venue. Returns the summary string (or null
// when the agent had nothing useful / failed) plus a diagnostic for
// enrichment_sources.serp. Best-effort: every failure degrades to null.
export async function gatherSerpSummary(opts: {
  perplexityKey: string;
  name: string;
  locationLine: string;
  category: string | null;
}): Promise<{ summary: string | null; diag: Record<string, unknown> }> {
  const { perplexityKey, name, locationLine, category } = opts;
  const prompt =
    `Research the venue "${name}"` +
    (locationLine ? ` in ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") + ".\n" +
    `Write a SHORT editorial blurb (at most 120 words) capturing: the vibe / ` +
    `atmosphere, its reputation, signature dishes or drinks, and any notable ` +
    `press or recognition. This is SOFT background color only — do NOT state ` +
    `ratings, exact prices, addresses, phone numbers, or precise facts; do not ` +
    `invent anything you cannot ground on the web. If you find nothing reliable, ` +
    `return null.\n` +
    `Return strict JSON: {"summary": "<blurb>"} or {"summary": null}.`;
  try {
    const r = await fetch(PERPLEXITY_AGENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${perplexityKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: prompt,
        preset: PERPLEXITY_AGENT_PRESET,
        instructions:
          "Provide brief, web-grounded editorial context about a venue. Output only JSON matching the schema. Never fabricate. Prefer a null summary over guessing.",
        max_steps: 6,
        response_format: { type: "json_schema", json_schema: { schema: SERP_SCHEMA } },
      }),
    });
    if (!r.ok) {
      return { summary: null, diag: { provider: "perplexity", ok: false, status: r.status } };
    }
    const d = (await r.json()) as {
      output?: { type?: string; content?: { text?: string }[] }[];
    };
    let text = "";
    for (const it of d.output ?? []) {
      if (it?.type === "message" && Array.isArray(it.content)) {
        for (const c of it.content) {
          if (typeof c?.text === "string") text += c.text;
        }
      }
    }
    const answer = (safeParseJson(text) as { summary?: unknown } | null) ?? {};
    const raw = typeof answer.summary === "string" ? answer.summary.trim() : "";
    // Word-cap defensively (prompt asks for <=120, but the agent can drift).
    const summary = raw
      ? raw.split(/\s+/).slice(0, 130).join(" ")
      : null;
    return {
      summary,
      diag: { provider: "perplexity", ok: !!summary, words: summary ? summary.split(/\s+/).length : 0 },
    };
  } catch {
    return { summary: null, diag: { provider: "perplexity", ok: false } };
  }
}
