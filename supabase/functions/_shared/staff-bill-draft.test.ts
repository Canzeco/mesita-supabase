// Unit tests for the WhatsApp bill-parsing money helpers (MESITA-142).
//   deno test supabase/functions/_shared/staff-bill-draft.test.ts
//
// This module turns free-form waiter messages ("la cuenta fue 850, propina
// 100") into subtotal/tip cents that feed the discount math. Getting the
// peso→cent scaling or code-stripping wrong charges the wrong amount, so the
// core parse paths are locked here. All pure — no network/DB.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  billDraftFromContext,
  billDraftHasAnyAmount,
  hasBillLabels,
  isBillDraftReady,
  mergeBillDraft,
  messageLooksLikeBill,
  normalizeLlmBillCents,
  parseBillParts,
  stripConsumerCodesForBillParse,
} from "./staff-bill-draft.ts";

Deno.test("normalizeLlmBillCents: small numbers are pesos, scaled to cents", () => {
  assertEquals(normalizeLlmBillCents(850), 85000); // pesos -> cents
  assertEquals(normalizeLlmBillCents(1), 100);
  assertEquals(normalizeLlmBillCents(9999), 999900);
});

Deno.test("normalizeLlmBillCents: >=10000 already cents, kept as-is", () => {
  assertEquals(normalizeLlmBillCents(10000), 10000);
  assertEquals(normalizeLlmBillCents(85000), 85000);
});

Deno.test("normalizeLlmBillCents: 0 stays 0, negatives/null rejected", () => {
  assertEquals(normalizeLlmBillCents(0), 0);
  assertEquals(normalizeLlmBillCents(-5), null);
  assertEquals(normalizeLlmBillCents(null), null);
});

Deno.test("parseBillParts: 'la cuenta fue 850' -> 85000¢ subtotal, no tip", () => {
  const d = parseBillParts("la cuenta fue 850");
  assertEquals(d.subtotal_cents, 85000);
  assertEquals(d.tip_cents, null);
});

Deno.test("parseBillParts: labeled subtotal + tip", () => {
  const d = parseBillParts("subtotal 850 propina 100");
  assertEquals(d.subtotal_cents, 85000);
  assertEquals(d.tip_cents, 10000);
});

Deno.test("parseBillParts: 'X + Y' pair maps to subtotal + tip", () => {
  const d = parseBillParts("850 + 100");
  assertEquals(d.subtotal_cents, 85000);
  assertEquals(d.tip_cents, 10000);
});

Deno.test("parseBillParts: decimals preserved and rounded to cents", () => {
  const d = parseBillParts("subtotal 850.50");
  assertEquals(d.subtotal_cents, 85050);
});

Deno.test("parseBillParts: 'sin propina' means tip explicitly 0", () => {
  const d = parseBillParts("sin propina");
  assertEquals(d.tip_cents, 0);
  assertEquals(d.subtotal_cents, null);
});

Deno.test("parseBillParts: empty / no-number text -> nulls", () => {
  assertEquals(parseBillParts(""), { subtotal_cents: null, tip_cents: null });
  assertEquals(parseBillParts("hola"), { subtotal_cents: null, tip_cents: null });
});

Deno.test("stripConsumerCodesForBillParse: a guest code is NOT read as money", () => {
  // 1234-5678 is a consumer code; only the 850 is the bill.
  const cleaned = stripConsumerCodesForBillParse("1234-5678 850");
  const d = parseBillParts("1234-5678 850");
  assert(!cleaned.includes("1234"));
  assertEquals(d.subtotal_cents, 85000);
  assertEquals(d.tip_cents, null);
});

Deno.test("hasBillLabels: detects money-ish labels", () => {
  assert(hasBillLabels("subtotal 850"));
  assert(hasBillLabels("propina 100"));
  assert(!hasBillLabels("850"));
});

Deno.test("mergeBillDraft: a lone follow-up number becomes the tip", () => {
  // Subtotal already saved, waiter sends "100" with no label -> that's the tip.
  const merged = mergeBillDraft(
    { subtotal_cents: 85000, tip_cents: null },
    { subtotal_cents: 10000, tip_cents: null },
    "100",
  );
  assertEquals(merged.subtotal_cents, 85000);
  assertEquals(merged.tip_cents, 10000);
});

Deno.test("mergeBillDraft: labeled parts overwrite the draft fields", () => {
  const merged = mergeBillDraft(
    { subtotal_cents: 85000, tip_cents: 5000 },
    { subtotal_cents: 90000, tip_cents: null },
    "subtotal 900",
  );
  assertEquals(merged.subtotal_cents, 90000);
  assertEquals(merged.tip_cents, 5000);
});

Deno.test("isBillDraftReady / billDraftHasAnyAmount", () => {
  assert(isBillDraftReady({ subtotal_cents: 85000, tip_cents: null }));
  assert(!isBillDraftReady({ subtotal_cents: 0, tip_cents: 100 }));
  assert(!isBillDraftReady({ subtotal_cents: null, tip_cents: 100 }));
  assert(billDraftHasAnyAmount({ subtotal_cents: null, tip_cents: 100 }));
  assert(!billDraftHasAnyAmount({ subtotal_cents: null, tip_cents: null }));
});

Deno.test("billDraftFromContext: reads cents out of session context, else nulls", () => {
  assertEquals(
    billDraftFromContext({ pending_bill: { subtotal_cents: 85000, tip_cents: 10000 } }),
    { subtotal_cents: 85000, tip_cents: 10000 },
  );
  assertEquals(billDraftFromContext({}), { subtotal_cents: null, tip_cents: null });
  assertEquals(
    billDraftFromContext({ pending_bill: "nope" }),
    { subtotal_cents: null, tip_cents: null },
  );
});

Deno.test("messageLooksLikeBill: true for amounts, false for chatter", () => {
  assert(messageLooksLikeBill("la cuenta fue 850"));
  assert(messageLooksLikeBill("sin propina"));
  assert(!messageLooksLikeBill("gracias!"));
});
