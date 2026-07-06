// Unit tests for the pure promo/format helpers in ticket-informal (MESITA-142).
//   deno test supabase/functions/_shared/ticket-informal.test.ts
//
// computeInformalBill/finalizeInformalTicket etc. take a live SupabaseClient
// and belong to integration coverage; here we lock the pure money helpers that
// the discount math depends on.

import { assertEquals } from "jsr:@std/assert@1";
import {
  formatMoneyMx,
  promoEligibleSubtotalCents,
} from "./ticket-informal.ts";

Deno.test("promoEligibleSubtotalCents: no cap -> whole subtotal is eligible", () => {
  assertEquals(promoEligibleSubtotalCents(85000, null), 85000);
  assertEquals(promoEligibleSubtotalCents(85000, undefined), 85000);
  assertEquals(promoEligibleSubtotalCents(85000, 0), 85000); // 0 = "no cap"
});

Deno.test("promoEligibleSubtotalCents: cap in pesos limits eligible cents", () => {
  // capPesos 500 -> 50000¢ ceiling.
  assertEquals(promoEligibleSubtotalCents(120000, 500), 50000);
  assertEquals(promoEligibleSubtotalCents(40000, 500), 40000); // under the cap
});

Deno.test("formatMoneyMx: renders cents as major-unit MXN with 2 decimals", () => {
  assertEquals(formatMoneyMx(85000), "$850.00 MXN");
  assertEquals(formatMoneyMx(99), "$0.99 MXN");
  assertEquals(formatMoneyMx(0), "$0.00 MXN");
  assertEquals(formatMoneyMx(50000, "USD"), "$500.00 USD");
});
