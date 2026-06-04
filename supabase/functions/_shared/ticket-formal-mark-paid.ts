// Shared formal-ticket payment finalization (Stripe webhook + business-mark-paid).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { FORMAL_STORY_KINDS } from "./ticket-kinds.ts";

const STORY_VERIFIED = new Set(["ai_verified", "waiter_verified"]);

export type FormalTicketForPayment = {
  id: string;
  venue_id: string;
  consumer_id: string;
  kind: string;
  status: string;
  story_status: string | null;
  cashback_cents: number | null;
  redeem_cents: number | null;
};

export type FinalizeFormalPaymentResult =
  | {
      ok: true;
      ticket: Record<string, unknown>;
      alreadyPaid?: boolean;
      awaitingStory?: boolean;
      cashbackCreditedCents: number;
      cashbackRedeemedCents: number;
      consumerBalanceAfterCents: number | null;
    }
  | { ok: false; error: string; status?: number; code?: string };

export async function finalizeFormalTicketPayment(
  admin: SupabaseClient,
  ticket: FormalTicketForPayment,
): Promise<FinalizeFormalPaymentResult> {
  if (ticket.status === "paid") {
    return {
      ok: true,
      ticket,
      alreadyPaid: true,
      cashbackCreditedCents: 0,
      cashbackRedeemedCents: 0,
      consumerBalanceAfterCents: null,
    };
  }
  if (ticket.status === "awaiting_story") {
    return {
      ok: true,
      ticket,
      alreadyPaid: true,
      awaitingStory: true,
      cashbackCreditedCents: 0,
      cashbackRedeemedCents: 0,
      consumerBalanceAfterCents: null,
    };
  }
  if (
    ticket.status !== "pending_pay" &&
    ticket.status !== "awaiting_payment_confirm"
  ) {
    return {
      ok: false,
      error: `Cannot mark ${ticket.status} ticket as paid`,
      status: 409,
    };
  }

  const paidAt = new Date().toISOString();
  const storyRequired = FORMAL_STORY_KINDS.has(ticket.kind);
  const storyOk = STORY_VERIFIED.has(ticket.story_status ?? "");
  const nextStatus = storyRequired && !storyOk ? "awaiting_story" : "paid";

  const updated = await admin
    .from("tickets")
    .update({ status: nextStatus, paid_at: paidAt })
    .eq("id", ticket.id)
    .eq("status", "pending_pay")
    .select("id, status, paid_at, cashback_cents, story_status")
    .single();
  if (updated.error) {
    return {
      ok: false,
      error: `ticket_update: ${updated.error.message}`,
      status: 500,
    };
  }

  if (nextStatus === "awaiting_story") {
    return {
      ok: true,
      ticket: updated.data,
      cashbackCreditedCents: 0,
      cashbackRedeemedCents: 0,
      consumerBalanceAfterCents: null,
      awaitingStory: true,
    };
  }

  const cashbackCents = ticket.cashback_cents ?? 0;
  const redeemCents = ticket.redeem_cents ?? 0;

  const consumerRow = await admin
    .from("consumers")
    .select("cashback_balance_cents")
    .eq("id", ticket.consumer_id)
    .single();
  if (consumerRow.error) {
    return {
      ok: false,
      error: `consumer_balance_read: ${consumerRow.error.message}`,
      status: 500,
    };
  }
  let balance = consumerRow.data.cashback_balance_cents ?? 0;

  if (redeemCents > 0) {
    if (redeemCents > balance) {
      return {
        ok: false,
        code: "redeem_exceeds_balance",
        error: `Consumer balance dropped below the ${redeemCents} cents this ticket would redeem.`,
        status: 409,
      };
    }
    balance -= redeemCents;
    const debit = await admin.from("cashback_ledger").insert({
      consumer_id: ticket.consumer_id,
      ticket_id: ticket.id,
      venue_id: ticket.venue_id,
      delta_cents: -redeemCents,
      balance_after_cents: balance,
      kind: "redeem",
    });
    if (debit.error) {
      return {
        ok: false,
        error: `ledger_redeem: ${debit.error.message}`,
        status: 500,
      };
    }
  }

  if (cashbackCents > 0) {
    balance += cashbackCents;
    const credit = await admin.from("cashback_ledger").insert({
      consumer_id: ticket.consumer_id,
      ticket_id: ticket.id,
      venue_id: ticket.venue_id,
      delta_cents: cashbackCents,
      balance_after_cents: balance,
      kind: "earn",
    });
    if (credit.error) {
      return {
        ok: false,
        error: `ledger_earn: ${credit.error.message}`,
        status: 500,
      };
    }
  }

  if (redeemCents > 0 || cashbackCents > 0) {
    const balanceUpdate = await admin
      .from("consumers")
      .update({ cashback_balance_cents: balance })
      .eq("id", ticket.consumer_id);
    if (balanceUpdate.error) {
      return {
        ok: false,
        error: `consumer_balance_write: ${balanceUpdate.error.message}`,
        status: 500,
      };
    }
  }

  return {
    ok: true,
    ticket: updated.data,
    cashbackCreditedCents: cashbackCents,
    cashbackRedeemedCents: redeemCents,
    consumerBalanceAfterCents: balance,
    awaitingStory: false,
  };
}
