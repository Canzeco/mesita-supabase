import { promoEligibleSubtotalCents } from "./ticket-informal.ts";

export type TicketBillSnapshot = {
  checkSubtotalCents: number;
  tipCents: number;
  totalCents: number;
  cashbackPercent: number;
  cashbackCents: number;
  redeemCents: number;
  discountPercent: number | null;
  discountCents: number | null;
  amountDueCents: number;
  eligibleCents: number;
};

export type ComputeTicketBillInput = {
  subtotal: number;
  tip: number;
  redeemRequested: number;
  isFormal: boolean;
  ratePercent: number;
  consumerBalance: number;
  capPesos: number | null;
};

export function computeTicketBill(
  input: ComputeTicketBillInput,
): { ok: true; snapshot: TicketBillSnapshot } | { ok: false; code?: string; error: string } {
  const { subtotal, tip, redeemRequested, isFormal, ratePercent, consumerBalance, capPesos } =
    input;

  if (subtotal === 0) {
    return { ok: false, error: "Check total can't be zero" };
  }

  const total = isFormal ? subtotal + tip : subtotal;
  const eligibleCents = promoEligibleSubtotalCents(subtotal, capPesos);

  let cashbackCents = 0;
  let redeemCents = 0;
  let discountCents = 0;
  let discountPercent: number | null = null;

  if (isFormal) {
    if (redeemRequested > consumerBalance) {
      return {
        ok: false,
        code: "redeem_exceeds_balance",
        error: `Consumer balance is ${consumerBalance} cents — can't redeem ${redeemRequested}.`,
      };
    }
    if (redeemRequested > total) {
      return {
        ok: false,
        code: "redeem_exceeds_total",
        error: `Redemption ${redeemRequested} can't exceed the check total ${total}.`,
      };
    }
    redeemCents = redeemRequested;
    cashbackCents = Math.floor((eligibleCents * ratePercent) / 100);
  } else {
    discountPercent = ratePercent;
    discountCents = Math.floor((eligibleCents * ratePercent) / 100);
    if (discountCents > subtotal) discountCents = subtotal;
    const payableCents = subtotal - discountCents;
    const cap = Math.min(consumerBalance, payableCents);
    if (redeemRequested > consumerBalance) {
      return {
        ok: false,
        code: "redeem_exceeds_balance",
        error: `Consumer balance is ${consumerBalance} cents — can't redeem ${redeemRequested}.`,
      };
    }
    if (redeemRequested > payableCents) {
      return {
        ok: false,
        code: "redeem_exceeds_total",
        error: `Redemption ${redeemRequested} can't exceed the amount due ${payableCents}.`,
      };
    }
    redeemCents = redeemRequested > 0 ? redeemRequested : cap;
  }

  const amountDueCents = isFormal
    ? Math.max(0, total - redeemCents)
    : Math.max(0, subtotal - (discountCents ?? 0) - redeemCents);

  return {
    ok: true,
    snapshot: {
      checkSubtotalCents: subtotal,
      tipCents: tip,
      totalCents: total,
      cashbackPercent: isFormal ? ratePercent : 0,
      cashbackCents: isFormal ? cashbackCents : 0,
      redeemCents,
      discountPercent,
      discountCents: isFormal ? null : discountCents,
      amountDueCents,
      eligibleCents,
    },
  };
}
