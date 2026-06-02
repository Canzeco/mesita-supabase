// LLM intent parsing for Staff WhatsApp (Mesita Ops). Handles messy input like
// "hey check this code 1234-5678" and structured bill replies.

import { extractConsumerCodeFromText, normalizeConsumerCodeInput } from "./consumer-code.ts";
import {
  type BillDraft,
  messageLooksLikeBill,
  normalizeLlmBillCents,
  parseBillParts,
} from "./staff-bill-draft.ts";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export type StaffMessageIntent = {
  intent:
    | "lookup_code"
    | "submit_bill"
    | "confirm_payment"
    | "select_venue"
    | "cancel"
    | "help"
    | "unknown";
  consumer_code: string | null;
  check_subtotal_cents: number | null;
  tip_cents: number | null;
  confirm: boolean | null;
  /** 0-based index when staff picks unit 1, 2, … */
  venue_index: number | null;
};

const EMPTY_INTENT: StaffMessageIntent = {
  intent: "unknown",
  consumer_code: null,
  check_subtotal_cents: null,
  tip_cents: null,
  confirm: null,
  venue_index: null,
};

const STATE_HINTS: Record<string, string> = {
  selecting_venue:
    "Staff must pick which restaurant unit they are working at (number or name).",
  idle: "Waiting for guest Mesita code (0000-0000). Bill amounts are not expected yet.",
  consumer_identified:
    "Guest verified. Staff may send bill in one or several messages (subtotal then tip). A new code switches guest.",
  awaiting_staff_payment_confirm:
    "Ticket open; waiting for staff to confirm they collected payment (listo/sí/ya cobré). Numbers are NOT a new bill.",
  awaiting_payment_confirm:
    "Same as awaiting_staff_payment_confirm.",
};

export async function parseStaffWhatsAppMessage(
  body: string,
  sessionState: string,
  conversationHistory = "",
  pendingBill?: BillDraft,
): Promise<StaffMessageIntent> {
  const heuristic = heuristicParse(body, sessionState, pendingBill);
  const openaiKey = Deno.env.get("OPENAI_KEY")?.trim();
  if (!openaiKey) return heuristic;

  const stateHint = STATE_HINTS[sessionState] ?? "Follow session state.";

  const system =
    "You parse WhatsApp messages from restaurant waitstaff using Mesita Ops (informal discount tickets, Mexico, Spanish/English mix). " +
    'Return JSON only: {"intent":"lookup_code"|"submit_bill"|"confirm_payment"|"select_venue"|"cancel"|"help"|"unknown",' +
    '"consumer_code":"0000-0000"|null,"check_subtotal_cents":number|null,"tip_cents":number|null,"confirm":boolean|null,"venue_index":number|null}. ' +
    "Rules:\n" +
    "- consumer_code: 8 digits as 0000-0000; extract from messy text.\n" +
    "- submit_bill: subtotal and/or tip in PESOS as integer CENTS (850 pesos → 85000). Either field may be null if only one amount this turn.\n" +
    "- confirm_payment: staff collected money (sí, listo, ya cobré, pagado, ok, confirmado).\n" +
    "- select_venue: picking unit from list (venue_index 0-based).\n" +
    "- cancel: cancelar, reset, stop.\n" +
    "- help: ayuda, ?, menú.\n" +
    "- Use RECENT CONVERSATION + pending bill draft: e.g. subtotal in an earlier message, tip only now.\n" +
    "- One message may include BOTH a guest code AND bill amounts.\n" +
    `- Current session: ${sessionState}. ${stateHint}`;

  const historyBlock = conversationHistory.trim()
    ? `Recent conversation (oldest first):\n${conversationHistory.trim()}\n\n`
    : "";

  const draftBlock =
    pendingBill &&
      (pendingBill.subtotal_cents != null || pendingBill.tip_cents != null)
      ? `Pending bill draft (already saved): subtotal_cents=${
        pendingBill.subtotal_cents ?? "null"
      } tip_cents=${pendingBill.tip_cents ?? "null"}\n\n`
      : "";

  const user =
    `${historyBlock}${draftBlock}Session state: ${sessionState}\nLatest message:\n${body.slice(0, 2000)}`;

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) return heuristic;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return mergeIntent(heuristic, parsed, sessionState, body);
  } catch {
    return heuristic;
  }
}

function mergeIntent(
  fallback: StaffMessageIntent,
  raw: Record<string, unknown>,
  sessionState: string,
  body: string,
): StaffMessageIntent {
  const intents = new Set([
    "lookup_code",
    "submit_bill",
    "confirm_payment",
    "select_venue",
    "cancel",
    "help",
    "unknown",
  ]);
  let intent = intents.has(String(raw.intent))
    ? (raw.intent as StaffMessageIntent["intent"])
    : fallback.intent;

  // Only trust a code present in THIS message (not conversation history).
  let consumer_code = extractConsumerCodeFromText(body);
  if (!consumer_code && typeof raw.consumer_code === "string") {
    const llmCode = normalizeConsumerCodeInput(raw.consumer_code);
    if (llmCode && body.includes(llmCode.replace("-", ""))) {
      consumer_code = llmCode;
    }
  }

  const llmSub = normalizeLlmBillCents(toCents(raw.check_subtotal_cents));
  const llmTip = normalizeLlmBillCents(toCents(raw.tip_cents));

  let check_subtotal_cents = llmSub ?? fallback.check_subtotal_cents;
  let tip_cents = llmTip ?? fallback.tip_cents;

  const parts = parseBillParts(body);
  if (parts.subtotal_cents != null) check_subtotal_cents = parts.subtotal_cents;
  if (parts.tip_cents != null) tip_cents = parts.tip_cents;

  if (isPaymentConfirmState(sessionState) && fallback.intent === "confirm_payment") {
    intent = "confirm_payment";
  } else if (
    isPaymentConfirmState(sessionState) &&
    intent === "submit_bill" &&
    !messageLooksLikeBill(body) &&
    fallback.intent === "confirm_payment"
  ) {
    intent = "confirm_payment";
  }

  if (
    consumer_code &&
    (check_subtotal_cents != null || tip_cents != null || messageLooksLikeBill(body))
  ) {
    if (intent === "unknown") intent = "lookup_code";
  }

  if (
    (check_subtotal_cents != null || tip_cents != null) &&
    sessionState === "consumer_identified" &&
    intent === "unknown"
  ) {
    intent = "submit_bill";
  }

  let venue_index: number | null = null;
  if (raw.venue_index != null) {
    const idx = Number(raw.venue_index);
    if (Number.isInteger(idx) && idx >= 0) venue_index = idx;
  }
  if (venue_index == null) venue_index = fallback.venue_index;

  let confirm: boolean | null = typeof raw.confirm === "boolean"
    ? raw.confirm
    : fallback.confirm;

  if (
    isPaymentConfirmState(sessionState) &&
    intent === "confirm_payment" &&
    confirm !== true &&
    fallback.confirm === true
  ) {
    confirm = true;
  }

  return {
    intent,
    consumer_code,
    check_subtotal_cents,
    tip_cents,
    confirm,
    venue_index,
  };
}

function isPaymentConfirmState(sessionState: string): boolean {
  return sessionState === "awaiting_staff_payment_confirm" ||
    sessionState === "awaiting_payment_confirm";
}

function heuristicParse(
  body: string,
  sessionState: string,
  pendingBill?: BillDraft,
): StaffMessageIntent {
  const lower = body.trim().toLowerCase();
  if (/^(help|\?|menu|ayuda|comandos)\b/.test(lower)) {
    return { ...EMPTY_INTENT, intent: "help" };
  }
  if (/^(cancel|cancelar|reset|stop|reiniciar)\b/.test(lower)) {
    return { ...EMPTY_INTENT, intent: "cancel" };
  }

  if (sessionState === "selecting_venue") {
    const numOnly = body.trim().match(/^(\d+)$/);
    if (numOnly) {
      return {
        ...EMPTY_INTENT,
        intent: "select_venue",
        venue_index: Number(numOnly[1]) - 1,
      };
    }
  }

  const code = extractConsumerCodeFromText(body);

  if (isPaymentConfirmState(sessionState)) {
    if (
      /^(yes|y|si|sí|confirm|confirmed|pagado|paid|listo|ok|cobrado|cobra|ya\s+cobr|hecho|done)\b/i
        .test(lower) ||
      /\b(ya\s+)?cobr[eé]\b/i.test(lower)
    ) {
      return { ...EMPTY_INTENT, intent: "confirm_payment", confirm: true };
    }
    if (!messageLooksLikeBill(body)) {
      return EMPTY_INTENT;
    }
  }

  if (code && (sessionState === "idle" || sessionState === "consumer_identified")) {
    const parts = parseBillParts(body);
    const hasBill = parts.subtotal_cents != null || parts.tip_cents != null;
    return {
      ...EMPTY_INTENT,
      intent: "lookup_code",
      consumer_code: code,
      check_subtotal_cents: parts.subtotal_cents,
      tip_cents: parts.tip_cents,
      confirm: null,
    };
  }

  if (sessionState === "consumer_identified" || sessionState === "idle") {
    const parts = parseBillParts(body);
    if (parts.subtotal_cents != null || parts.tip_cents != null) {
      return {
        ...EMPTY_INTENT,
        intent: "submit_bill",
        consumer_code: code,
        check_subtotal_cents: parts.subtotal_cents,
        tip_cents: parts.tip_cents,
        confirm: null,
      };
    }
    if (pendingBill?.subtotal_cents != null && /\d/.test(body)) {
      return { ...EMPTY_INTENT, intent: "submit_bill" };
    }
  }

  if (code) {
    return { ...EMPTY_INTENT, intent: "lookup_code", consumer_code: code };
  }

  if (isCasualStaffMessage(body)) {
    return { ...EMPTY_INTENT, intent: "unknown" };
  }

  if (sessionState === "consumer_identified" && /\d/.test(body)) {
    return { ...EMPTY_INTENT, intent: "submit_bill" };
  }

  return EMPTY_INTENT;
}

export function isCasualStaffMessage(body: string): boolean {
  const t = body.trim();
  if (!t) return true;
  return /^(hi|hello|hey|hola|buenas|buenos|qué tal|que tal|good morning|good afternoon|ok|vale|gracias|thanks)\b/i
    .test(t);
}

function toCents(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}
