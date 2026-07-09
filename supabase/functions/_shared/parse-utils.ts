// Small JSON / string parsing helpers shared by the Enricher and business onboarding.

/** De-dupe string URLs (or any strings) preserving first-seen order. */
export function dedup(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of arr) {
    if (typeof u === "string" && u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

export function numOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Turn a category slug (`fine_dining`) into a display label (`Fine Dining`). */
export function humanizeCategorySlug(
  category: string | null | undefined,
): string | null {
  if (!category) return null;
  const trimmed = category.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Parse the first JSON object from an LLM response (strips markdown fences).
 * Hardened for Sonar/Agent `json_schema` responses under load (MESITA-192):
 * trailing commas, truncated closing braces, and leading/trailing prose.
 */
export function safeParseJson(content: string): unknown | null {
  if (!content) return null;
  let s = content.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  let end = s.lastIndexOf("}");
  // Truncated responses sometimes omit the final `}` — close the object if we
  // still have a plausible `{…` payload (common under concurrent Sonar load).
  if (end === -1 || end <= start) {
    const open = s.slice(start);
    if (open.length < 2) return null;
    s = open + "}";
    end = s.length - 1;
  } else {
    s = s.slice(start, end + 1);
  }
  const attempts = [s, s.replace(/,\s*([}\]])/g, "$1")];
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  return null;
}
