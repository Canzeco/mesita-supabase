/** Parse a non-negative integer cent amount from JSON / LLM / form input. */
export function toCents(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}
