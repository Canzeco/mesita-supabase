// Partial bill amounts across multiple WhatsApp messages (session.context).

import { extractConsumerCodeFromText } from "./consumer-code.ts";

export type BillDraft = {
  subtotal_cents: number | null;
  tip_cents: number | null;
};

export function billDraftFromContext(
  context: Record<string, unknown>,
): BillDraft {
  const raw = context.pending_bill;
  if (!raw || typeof raw !== "object") {
    return { subtotal_cents: null, tip_cents: null };
  }
  const o = raw as Record<string, unknown>;
  return {
    subtotal_cents: toCents(o.subtotal_cents),
    tip_cents: toCents(o.tip_cents),
  };
}

export function billDraftToContext(draft: BillDraft): Record<string, unknown> {
  return {
    subtotal_cents: draft.subtotal_cents,
    tip_cents: draft.tip_cents,
  };
}

/** LLM sometimes returns pesos (850) instead of cents (85000). */
export function normalizeLlmBillCents(v: number | null): number | null {
  if (v == null) return null;
  const n = Math.trunc(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0;
  // 1–9999 → almost certainly pesos from the model
  if (n < 10000) return n * 100;
  return n;
}

/** Remove guest codes so 1234-5678 850 100 does not treat code digits as money. */
export function stripConsumerCodesForBillParse(text: string): string {
  let t = text;
  const code = extractConsumerCodeFromText(text);
  if (code) {
    t = t.replace(code, " ");
    t = t.replace(code.replace("-", " "), " ");
    t = t.replace(code.replace("-", ""), " ");
  }
  t = t.replace(/\b[0-9]{4}[-\s]?[0-9]{4}\b/g, " ");
  t = t.replace(/\b[0-9]{8}\b/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

/** Parse subtotal/tip from one message (may be partial). */
export function parseBillParts(text: string): BillDraft {
  const t = stripConsumerCodesForBillParse(text.replace(/,/g, "")).trim();
  if (!t) return { subtotal_cents: null, tip_cents: null };

  const lower = t.toLowerCase();

  if (/^(sin\s+propina|sin\s+tip|propina\s+0|tip\s+0|no\s+tip|nada\s+de\s+propina)\b/i.test(
    lower,
  )) {
    return { subtotal_cents: null, tip_cents: 0 };
  }

  const plusPair = t.match(
    /([0-9]+(?:\.[0-9]{1,2})?)\s*(?:\+|y|and|mas|más|con)\s*(?:propina\s+)?([0-9]+(?:\.[0-9]{1,2})?)/i,
  );
  if (plusPair) {
    return {
      subtotal_cents: moneyToCents(plusPair[1]),
      tip_cents: moneyToCents(plusPair[2]),
    };
  }

  const subtotalMatch = t.match(
    /(?:subtotal|subtot|cuenta|bill|total\s+de\s+cuenta)[:\s]*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
  );
  const tipMatch = t.match(
    /(?:tip|propina|prop)[:\s]*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
  );

  if (subtotalMatch) {
    return {
      subtotal_cents: moneyToCents(subtotalMatch[1]),
      tip_cents: tipMatch ? moneyToCents(tipMatch[1]) : null,
    };
  }

  if (tipMatch) {
    return {
      subtotal_cents: null,
      tip_cents: moneyToCents(tipMatch[1]),
    };
  }

  const cuentaPhrase = t.match(
    /(?:cuenta|total|son|fue|eran|sale|qued[oó])\s*(?:en|de)?\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
  );
  if (cuentaPhrase && !tipMatch) {
    return {
      subtotal_cents: moneyToCents(cuentaPhrase[1]),
      tip_cents: null,
    };
  }

  const dollarNums = [...t.matchAll(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/g)]
    .map((m) => moneyToCents(m[1]))
    .filter((n): n is number => n != null);

  if (dollarNums.length >= 2) {
    return { subtotal_cents: dollarNums[0], tip_cents: dollarNums[1] };
  }
  if (dollarNums.length === 1) {
    return { subtotal_cents: dollarNums[0], tip_cents: null };
  }

  const nums = [...t.matchAll(/([0-9]+(?:\.[0-9]{1,2})?)/g)]
    .map((m) => moneyToCents(m[1]))
    .filter((n): n is number => n != null);

  if (nums.length >= 2) {
    return { subtotal_cents: nums[0], tip_cents: nums[1] };
  }

  if (nums.length === 1) {
    return { subtotal_cents: nums[0], tip_cents: null };
  }

  return { subtotal_cents: null, tip_cents: null };
}

export function hasBillLabels(text: string): boolean {
  return /(?:subtotal|subtot|cuenta|bill|tip|propina|prop|total)\b/i.test(text);
}

/**
 * Merge amounts from a new message into the session draft.
 * If subtotal was already saved and the waiter sends one more number without labels, treat it as tip.
 */
export function mergeBillDraft(
  existing: BillDraft,
  parts: BillDraft,
  latestMessage: string,
): BillDraft {
  let subtotal = parts.subtotal_cents ?? existing.subtotal_cents;
  let tip = parts.tip_cents ?? existing.tip_cents;

  const singleNumber =
    parts.subtotal_cents != null && parts.tip_cents == null &&
    !hasBillLabels(latestMessage);

  if (
    singleNumber &&
    existing.subtotal_cents != null &&
    existing.tip_cents == null &&
    parts.subtotal_cents != null
  ) {
    return {
      subtotal_cents: existing.subtotal_cents,
      tip_cents: parts.subtotal_cents,
    };
  }

  if (parts.subtotal_cents != null) subtotal = parts.subtotal_cents;
  if (parts.tip_cents != null) tip = parts.tip_cents;

  return { subtotal_cents: subtotal, tip_cents: tip };
}

/** Combine regex parse + LLM fields, then merge into session draft. */
export function buildIncomingBill(
  body: string,
  parts: BillDraft,
  intent: {
    check_subtotal_cents: number | null;
    tip_cents: number | null;
  },
  draft: BillDraft,
): BillDraft {
  const fromIntent: BillDraft = {
    subtotal_cents: normalizeLlmBillCents(intent.check_subtotal_cents),
    tip_cents: normalizeLlmBillCents(intent.tip_cents),
  };

  const incoming: BillDraft = {
    subtotal_cents: parts.subtotal_cents ?? fromIntent.subtotal_cents,
    tip_cents: parts.tip_cents ?? fromIntent.tip_cents,
  };

  return mergeBillDraft(draft, incoming, body);
}

export function isBillDraftReady(draft: BillDraft): boolean {
  return draft.subtotal_cents != null && draft.subtotal_cents > 0 &&
    draft.tip_cents != null && draft.tip_cents >= 0;
}

export function billDraftHasAnyAmount(draft: BillDraft): boolean {
  return draft.subtotal_cents != null || draft.tip_cents != null;
}

export function billDraftNeedMessage(draft: BillDraft): string {
  if (draft.subtotal_cents == null) {
    return "Manda el subtotal (ej. SUBTOTAL 850, solo 850, o «la cuenta fue 850»).";
  }
  if (draft.tip_cents == null) {
    return (
      `Tengo subtotal ${formatPesos(draft.subtotal_cents)} ✓\n` +
      `¿Cuánto de propina? (PROPINA 100, solo 100, o 0 / sin propina).`
    );
  }
  return "Manda SUBTOTAL y PROPINA, o dos números: 850 100 (pesos).";
}

export function messageLooksLikeBill(body: string): boolean {
  const parts = parseBillParts(body);
  if (parts.subtotal_cents != null || parts.tip_cents != null) return true;
  return /^(sin\s+propina|sin\s+tip)/i.test(body.trim());
}

function formatPesos(cents: number): string {
  return `$${(cents / 100).toLocaleString("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function moneyToCents(v: string): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function toCents(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}
