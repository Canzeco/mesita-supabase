// Informal (discount) ticket math — shared by business-create-ticket and Staff
// WhatsApp Type-A flow.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { isConsumerFirstVisit, selectVenueRate } from "./membership.ts";

export type VenueRateRow = {
  id: string;
  name: string;
  cashback_percent: number;
  welcome_free_rate: number | null;
  welcome_premium_rate: number | null;
  free_rate: number | null;
  premium_rate: number | null;
  monthly_promo_cap: number | null;
  fiscal_type: string;
  listing_type: string;
  status: string;
};

export type ConsumerRow = {
  id: string;
  code: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  cashback_balance_cents: number | null;
  tier_key: string | null;
  tier_origin: string | null;
  consumer_instagram_followers_count: number | null;
  phone: string | null;
};

export type InformalBillCalc = {
  subtotal: number;
  tip: number;
  total: number;
  eligibleCents: number;
  ratePercent: number;
  discountPercent: number;
  discountCents: number;
  redeemCents: number;
  amountDueCents: number;
};

/** Promo rate applies to food/drink subtotal only — tip is excluded. */
export function promoEligibleSubtotalCents(
  subtotal: number,
  capPesos: number | null | undefined,
): number {
  if (capPesos != null && capPesos > 0) {
    return Math.min(subtotal, capPesos * 100);
  }
  return subtotal;
}

export async function computeInformalBill(
  admin: SupabaseClient,
  venue: VenueRateRow,
  consumer: ConsumerRow,
  subtotal: number,
  tip: number,
  redeemRequested = 0,
): Promise<InformalBillCalc> {
  const total = subtotal;
  const firstVisit = await isConsumerFirstVisit(admin, consumer.id, venue.id);
  const ratePercent = selectVenueRate(venue, consumer.tier_key, firstVisit);

  const capPesos = venue.monthly_promo_cap;
  const eligibleCents = promoEligibleSubtotalCents(subtotal, capPesos);

  const discountPercent = ratePercent;
  let discountCents = Math.floor((eligibleCents * ratePercent) / 100);
  if (discountCents > subtotal) discountCents = subtotal;

  const consumerBalance = consumer.cashback_balance_cents ?? 0;
  const payableCents = subtotal - discountCents;
  const cap = Math.min(consumerBalance, payableCents);
  const redeemCents = redeemRequested > 0 ? redeemRequested : cap;
  const amountDueCents = payableCents - redeemCents;

  return {
    subtotal,
    tip: 0,
    total,
    eligibleCents,
    ratePercent,
    discountPercent,
    discountCents,
    redeemCents,
    amountDueCents,
  };
}

export function formatMoneyMx(cents: number, currency = "MXN"): string {
  const major = (cents / 100).toFixed(2);
  return `$${major} ${currency}`;
}

/** Payload for consumer Pay → Tickets (Realtime notification). */
export function buildConsumerBillPayload(
  venue: {
    name: string;
    photos?: string[] | null;
    slug?: string | null;
    monthly_promo_cap?: number | null;
  },
  calc: InformalBillCalc,
  venueId: string,
): Record<string, unknown> {
  const discount = calc.discountCents ?? 0;
  const redeem = calc.redeemCents ?? 0;
  return {
    venue_id: venueId,
    venue_slug: venue.slug ?? null,
    venue_name: venue.name,
    venue_photo_url: venue.photos?.[0] ?? null,
    check_subtotal_cents: calc.subtotal,
    tip_cents: calc.tip,
    total_cents: calc.total,
    discount_cents: discount,
    discount_percent: calc.discountPercent,
    redeem_cents: redeem,
    total_reward_cents: discount + redeem,
    reward_cap_mxn: venue.monthly_promo_cap ?? null,
    amount_due_cents: calc.amountDueCents,
    currency: "MXN",
  };
}

export async function finalizeInformalTicket(
  admin: SupabaseClient,
  ticketId: string,
  consumerId: string,
  venueId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ticket = await admin
    .from("tickets")
    .select(
      "id, status, redeem_cents, discount_cents, consumer_payment_confirmed_at, staff_payment_confirmed_at",
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticket.error || !ticket.data) {
    return { ok: false, error: ticket.error?.message ?? "ticket not found" };
  }
  if (ticket.data.status === "revealed") return { ok: true };
  if (
    !ticket.data.consumer_payment_confirmed_at ||
    !ticket.data.staff_payment_confirmed_at
  ) {
    return { ok: false, error: "payment confirmations incomplete" };
  }

  const redeemCents = ticket.data.redeem_cents ?? 0;
  const consumerRow = await admin
    .from("consumers")
    .select("cashback_balance_cents")
    .eq("id", consumerId)
    .single();
  if (consumerRow.error) {
    return { ok: false, error: consumerRow.error.message };
  }
  const balance = consumerRow.data.cashback_balance_cents ?? 0;

  const now = new Date().toISOString();
  const update = await admin
    .from("tickets")
    .update({
      status: "revealed",
      revealed_at: now,
      paid_at: now,
    })
    .eq("id", ticketId);
  if (update.error) return { ok: false, error: update.error.message };

  if (redeemCents > 0) {
    const newBalance = balance - redeemCents;
    await admin.from("cashback_ledger").insert({
      consumer_id: consumerId,
      ticket_id: ticketId,
      venue_id: venueId,
      delta_cents: -redeemCents,
      balance_after_cents: newBalance,
      kind: "redeem",
    });
    await admin
      .from("consumers")
      .update({ cashback_balance_cents: newBalance })
      .eq("id", consumerId);
  }

  return { ok: true };
}

const REVIEW_READY_STATUSES = new Set(["revealed", "paid", "awaiting_story"]);

/** Reveal ticket + ensure review inbox row exists before consumer submits review. */
export async function prepareTicketForReview(
  admin: SupabaseClient,
  ticketId: string,
  consumerId: string,
): Promise<{ ok: true; venueId: string } | { ok: false; error: string }> {
  const ticket = await admin
    .from("tickets")
    .select(
      "id, venue_id, status, consumer_payment_confirmed_at, staff_payment_confirmed_at",
    )
    .eq("id", ticketId)
    .eq("consumer_id", consumerId)
    .maybeSingle();
  if (ticket.error || !ticket.data) {
    return { ok: false, error: ticket.error?.message ?? "Ticket not found" };
  }

  const row = ticket.data;
  if (REVIEW_READY_STATUSES.has(row.status)) {
    await ensureConsumerReviewNotification(
      admin,
      consumerId,
      ticketId,
      row.venue_id,
    );
    return { ok: true, venueId: row.venue_id };
  }

  if (
    row.status === "awaiting_payment_confirm" &&
    row.consumer_payment_confirmed_at
  ) {
    const now = new Date().toISOString();
    if (!row.staff_payment_confirmed_at) {
      const staffConfirm = await admin
        .from("tickets")
        .update({ staff_payment_confirmed_at: now })
        .eq("id", ticketId);
      if (staffConfirm.error) {
        return { ok: false, error: staffConfirm.error.message };
      }
    }

    const fin = await finalizeInformalTicket(
      admin,
      ticketId,
      consumerId,
      row.venue_id,
    );
    if (!fin.ok) return fin;

    await ensureConsumerReviewNotification(
      admin,
      consumerId,
      ticketId,
      row.venue_id,
    );
    return { ok: true, venueId: row.venue_id };
  }

  return { ok: false, error: "Ticket is not ready for review" };
}

export async function ensureConsumerReviewNotification(
  admin: SupabaseClient,
  consumerId: string,
  ticketId: string,
  venueId: string,
): Promise<void> {
  const existing = await admin
    .from("consumer_pay_notifications")
    .select("id")
    .eq("ticket_id", ticketId)
    .eq("consumer_id", consumerId)
    .eq("kind", "review")
    .maybeSingle();
  if (existing.data) return;

  const [venueRes, ticketRes] = await Promise.all([
    admin.from("venues").select("name, slug, photos").eq("id", venueId).single(),
    admin
      .from("tickets")
      .select(
        "kind, discount_cents, redeem_cents, discount_percent, cashback_percent, cashback_cents, total_cents, check_subtotal_cents, tip_cents",
      )
      .eq("id", ticketId)
      .single(),
  ]);

  const v = venueRes.data;
  const t = ticketRes.data;
  const discount = t?.discount_cents ?? 0;
  const redeem = t?.redeem_cents ?? 0;
  const cashback = t?.cashback_cents ?? 0;

  await admin.from("consumer_pay_notifications").insert({
    consumer_id: consumerId,
    ticket_id: ticketId,
    kind: "review",
    status: "pending",
    payload: {
      venue_id: venueId,
      venue_slug: v?.slug ?? null,
      venue_name: v?.name ?? "Partner venue",
      venue_photo_url: v?.photos?.[0] ?? null,
      ticket_kind: t?.kind ?? null,
      check_subtotal_cents: t?.check_subtotal_cents ?? null,
      tip_cents: t?.tip_cents ?? null,
      discount_cents: discount,
      discount_percent: t?.discount_percent ?? null,
      cashback_percent: t?.cashback_percent ?? null,
      cashback_cents: cashback,
      redeem_cents: redeem,
      total_reward_cents: discount + redeem + cashback,
      total_cents: t?.total_cents ?? null,
      currency: "MXN",
    },
  });
}
