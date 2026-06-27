import { promoEligibleSubtotalCents } from "./ticket-informal.ts";

export type TicketBillSnapshot = {
  checkSubtotalCents: number;
  tipCents: number;
  totalCents: number;
  discountPercent: number;
  discountCents: number;
  amountDueCents: number;
  eligibleCents: number;
};

export type ComputeTicketBillInput = {
  subtotal: number;
  ratePercent: number;
  capPesos: number | null;
};

// Discounts only: the promo rate applies to the subtotal, the discount is
// applied at the bill, and the consumer pays the place directly. Mesita never
// holds a balance, so there is no tip line, redemption, or credit here.
export function computeTicketBill(
  input: ComputeTicketBillInput,
): { ok: true; snapshot: TicketBillSnapshot } | { ok: false; code?: string; error: string } {
  const { subtotal, ratePercent, capPesos } = input;

  if (subtotal === 0) {
    return { ok: false, error: "Check total can't be zero" };
  }

  const total = subtotal;
  const eligibleCents = promoEligibleSubtotalCents(subtotal, capPesos);

  const discountPercent = ratePercent;
  let discountCents = Math.floor((eligibleCents * ratePercent) / 100);
  if (discountCents > subtotal) discountCents = subtotal;

  const amountDueCents = Math.max(0, subtotal - discountCents);

  return {
    ok: true,
    snapshot: {
      checkSubtotalCents: subtotal,
      tipCents: 0,
      totalCents: total,
      discountPercent,
      discountCents,
      amountDueCents,
      eligibleCents,
    },
  };
}
