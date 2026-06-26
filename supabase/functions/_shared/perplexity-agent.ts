// Shared Perplexity Agent (pro-search) client. One fetch/parse contract for
// every Atlas Perplexity call: Agent X's SERP summary (atlas-serp.ts) and Agent
// Y's channel fill + phone/email legs (atlas-channel-discovery.ts). Best-effort:
// any non-2xx / network / parse failure returns null, so callers degrade to null.

import { safeParseJson } from "./parse-utils.ts";

const PERPLEXITY_AGENT_URL = "https://api.perplexity.ai/v1/agent";
const PERPLEXITY_AGENT_PRESET = "pro-search";

// Default agent instructions — URL resolution (Agent Y's discovery + phone/email
// legs). Agent X overrides with its own editorial-context instructions.
const DEFAULT_INSTRUCTIONS =
  "Resolve venue URLs by anchoring on the official website and trusting the links the site itself points to. Output only JSON matching the schema. Never fabricate URLs; prefer null when unsure.";

// Call the managed Perplexity Agent once. Returns the schema JSON answer plus the
// source URLs the agent actually cited (annotations) — both host-locked, so
// callers must re-validate every URL before trusting it. null on any failure.
export async function callPerplexityAgent(
  key: string,
  input: string,
  schema: unknown,
  opts: { instructions?: string; maxSteps?: number } = {},
): Promise<{ answer: Record<string, unknown>; hitUrls: string[] } | null> {
  try {
    const r = await fetch(PERPLEXITY_AGENT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input,
        preset: PERPLEXITY_AGENT_PRESET,
        instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
        max_steps: opts.maxSteps ?? 8,
        response_format: { type: "json_schema", json_schema: { schema } },
      }),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      output?: {
        type?: string;
        content?: { text?: string; annotations?: { url?: unknown }[] }[];
      }[];
    };
    let text = "";
    const hitUrls: string[] = [];
    for (const it of d.output ?? []) {
      if (it?.type === "message" && Array.isArray(it.content)) {
        for (const c of it.content) {
          if (typeof c?.text === "string") text += c.text;
          for (const a of c?.annotations ?? []) {
            if (a && typeof a.url === "string") hitUrls.push(a.url);
          }
        }
      }
    }
    const answer = (safeParseJson(text) as Record<string, unknown> | null) ?? {};
    return { answer, hitUrls };
  } catch {
    return null;
  }
}
