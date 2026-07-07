// Atlas SERP summary — Step S3, "Agent X" (Perplexity Agent, pro-search). A fast
// research pass that returns a SHORT web-grounded editorial blurb (vibe,
// reputation, signature dishes/drinks, notable press) used as SOFT context only —
// never an authoritative source of facts, ratings, or prices. Its summary grounds
// Agent Y's link selection (enrich-channel-discovery.ts) AND the final synthesis.
// Shares the one Perplexity Agent client (perplexity-agent.ts) with Agent Y.

import { callPerplexityAgent } from "./perplexity-agent.ts";

const SERP_SCHEMA = {
  type: "object",
  properties: { summary: { type: ["string", "null"] } },
} as const;

// Agent X — SERP AI Summary (child G / MESITA-204). This blurb is SOFT grounding
// consumed twice downstream: it anchors Agent Y's link selection and seeds the
// final About synthesis. So it must be identity-rich (what/where/why-notable) yet
// strictly non-authoritative — no facts a later step will persist as truth.
const SERP_INSTRUCTIONS =
  "You are a research assistant that writes ONE short, web-grounded editorial " +
  "paragraph about a place, used only as soft background context for later steps. " +
  "Capture its identity and character — what it is, its vibe/atmosphere, reputation, " +
  "signature dishes or drinks, and any notable press or recognition. Do NOT state " +
  "ratings, prices, addresses, phone numbers, hours, or any precise fact a reader " +
  "could quote as authoritative. Ground every claim in what you actually find on the " +
  "web; invent nothing. If you cannot find a place matching the given name and " +
  "location, prefer a null summary over guessing. Output ONLY JSON matching the schema.";

// Web-grounded editorial color for a place. Returns the summary string (or null
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
    `Research the place "${name}"` +
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
