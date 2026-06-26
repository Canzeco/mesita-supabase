// Atlas SERP summary — Step S2 · P2 (Perplexity, niche). A fast Perplexity
// research pass that returns a SHORT web-grounded editorial blurb (vibe,
// reputation, signature dishes/drinks, notable press) used as SOFT context only —
// never an authoritative source of facts, ratings, or prices. Its summary grounds
// P3's discovery prompts AND the final Cognition synthesis. Shares the one
// Perplexity Agent client (perplexity-agent.ts) with P3.

import { callPerplexityAgent } from "./perplexity-agent.ts";

const SERP_SCHEMA = {
  type: "object",
  properties: { summary: { type: ["string", "null"] } },
} as const;

const SERP_INSTRUCTIONS =
  "Provide brief, web-grounded editorial context about a venue. Output only JSON matching the schema. Never fabricate. Prefer a null summary over guessing.";

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

  const res = await callPerplexityAgent(perplexityKey, prompt, SERP_SCHEMA, {
    instructions: SERP_INSTRUCTIONS,
    maxSteps: 6,
  });
  const raw = typeof res?.answer.summary === "string" ? res.answer.summary.trim() : "";
  // Word-cap defensively (prompt asks for <=120, but the agent can drift).
  const summary = raw ? raw.split(/\s+/).slice(0, 130).join(" ") : null;
  return {
    summary,
    diag: {
      provider: "perplexity",
      ok: !!summary,
      words: summary ? summary.split(/\s+/).length : 0,
    },
  };
}
