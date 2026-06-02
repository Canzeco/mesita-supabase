// Consumer QR codes: sequential 8 digits, canonical form 0000-0000 … 9999-9999.

export const CONSUMER_CODE_RE = /^[0-9]{4}-[0-9]{4}$/;

export function formatSequentialCode(n: number): string {
  const hi = Math.floor(n / 10000);
  const lo = n % 10000;
  return `${String(hi).padStart(4, "0")}-${String(lo).padStart(4, "0")}`;
}

export function isCanonicalConsumerCode(code: string): boolean {
  return CONSUMER_CODE_RE.test(code);
}

/** Parse staff/validator input into a DB lookup key (8 digits only). */
export function normalizeConsumerCodeInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (CONSUMER_CODE_RE.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length === 8) {
    return formatSequentialCode(Number(digits));
  }
  return null;
}

/** Extract a consumer code from free-form text (regex fallback before LLM). */
export function extractConsumerCodeFromText(text: string): string | null {
  const hyphen = text.match(/\b([0-9]{4}[-\s]?[0-9]{4})\b/);
  if (hyphen) {
    const n = normalizeConsumerCodeInput(hyphen[1].replace(/\s/g, ""));
    if (n) return n;
  }
  const eight = text.match(/\b([0-9]{8})\b/);
  if (eight) return normalizeConsumerCodeInput(eight[1]);
  return null;
}

export function displayConsumerCode(code: string): string {
  if (CONSUMER_CODE_RE.test(code)) return code;
  const digits = code.replace(/[^0-9]/g, "");
  if (digits.length === 8) return formatSequentialCode(Number(digits));
  return code;
}
