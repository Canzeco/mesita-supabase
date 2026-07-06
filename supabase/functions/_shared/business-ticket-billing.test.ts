// Unit tests for the ticket discount math (MESITA-142). Pure, no network/DB.
//   deno test supabase/functions/_shared/business-ticket-billing.test.ts
//
// This is the money computation that decides how much a guest's bill is
// discounted. Amounts are in cents. Discounts only — Mesita never holds a
// balance, so the invariant is: discount ≤ subtotal, amountDue = subtotal −
// discount, and the tip line is always 0.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { computeTicketBill } from "./business-ticket-billing.ts";

Deno.test("computeTicketBill: rejects a zero subtotal", () => {
  const res = computeTicketBill({ subtotal: 0, ratePercent: 10, capPesos: null });
  assert(!res.ok);
});

Deno.test("computeTicketBill: 10% off a $850 (85000¢) bill, no cap", () => {
  const res = computeTicketBill({ subtotal: 85000, ratePercent: 10, capPesos: null });
  assert(res.ok);
  const s = res.snapshot;
  assertEquals(s.checkSubtotalCents, 85000);
  assertEquals(s.tipCents, 0);
  assertEquals(s.totalCents, 85000);
  assertEquals(s.discountPercent, 10);
  assertEquals(s.eligibleCents, 85000);
  assertEquals(s.discountCents, 8500);
  assertEquals(s.amountDueCents, 76500);
});

Deno.test("computeTicketBill: floors fractional discount cents (never over-discounts)", () => {
  // 12345¢ * 7% = 864.15¢ -> floor 864.
  const res = computeTicketBill({ subtotal: 12345, ratePercent: 7, capPesos: null });
  assert(res.ok);
  assertEquals(res.snapshot.discountCents, 864);
  assertEquals(res.snapshot.amountDueCents, 12345 - 864);
});

Deno.test("computeTicketBill: monthly cap limits the eligible subtotal", () => {
  // capPesos 500 -> eligible capped at 50000¢. 20% of 50000 = 10000, not
  // 20% of the full 120000 (=24000).
  const res = computeTicketBill({ subtotal: 120000, ratePercent: 20, capPesos: 500 });
  assert(res.ok);
  assertEquals(res.snapshot.eligibleCents, 50000);
  assertEquals(res.snapshot.discountCents, 10000);
  assertEquals(res.snapshot.amountDueCents, 110000);
});

Deno.test("computeTicketBill: cap above subtotal leaves the whole subtotal eligible", () => {
  const res = computeTicketBill({ subtotal: 30000, ratePercent: 10, capPesos: 500 });
  assert(res.ok);
  assertEquals(res.snapshot.eligibleCents, 30000);
  assertEquals(res.snapshot.discountCents, 3000);
});

Deno.test("computeTicketBill: 0% rate yields no discount, full amount due", () => {
  const res = computeTicketBill({ subtotal: 50000, ratePercent: 0, capPesos: null });
  assert(res.ok);
  assertEquals(res.snapshot.discountCents, 0);
  assertEquals(res.snapshot.amountDueCents, 50000);
});

Deno.test("computeTicketBill: discount can never exceed the subtotal (amountDue ≥ 0)", () => {
  // A 150% rate is nonsensical but the guard must still hold the money invariant.
  const res = computeTicketBill({ subtotal: 10000, ratePercent: 150, capPesos: null });
  assert(res.ok);
  assert(res.snapshot.discountCents <= res.snapshot.checkSubtotalCents);
  assert(res.snapshot.amountDueCents >= 0);
  assertEquals(res.snapshot.discountCents, 10000);
  assertEquals(res.snapshot.amountDueCents, 0);
});
