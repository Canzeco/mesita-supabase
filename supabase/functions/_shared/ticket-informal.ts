// Discount ticket math — shared by business-web-create-ticket and the Staff
// WhatsApp Type-A flow. Discounts only: Mesita never holds a balance, so there
// is no redeem/ledger step — the discount is applied straight to the bill.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { instagramHandleFromUrl } from "./apify.ts";
import { isConsumerFirstVisit, selectprojectRate } from "./membership.ts";

export type PlaceRateRow = {
  id: string;
  name: string;
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
  place: PlaceRateRow,
  consumer: ConsumerRow,
  subtotal: number,
  _tip: number,
): Promise<InformalBillCalc> {
  const total = subtotal;
  const firstVisit = await isConsumerFirstVisit(admin, consumer.id, place.id);
  const ratePercent = selectprojectRate(place, consumer.tier_key, firstVisit);

  const capPesos = place.monthly_promo_cap;
  const eligibleCents = promoEligibleSubtotalCents(subtotal, capPesos);

  const discountPercent = ratePercent;
  let discountCents = Math.floor((eligibleCents * ratePercent) / 100);
  if (discountCents > subtotal) discountCents = subtotal;

  const amountDueCents = subtotal - discountCents;

  return {
    subtotal,
    tip: 0,
    total,
    eligibleCents,
    ratePercent,
    discountPercent,
    discountCents,
    amountDueCents,
  };
}

export function formatMoneyMx(cents: number, currency = "MXN"): string {
  const major = (cents / 100).toFixed(2);
  return `$${major} ${currency}`;
}

/** Payload for consumer Pay → Tickets (Realtime notification). */
export function placeInstagramHandleForPayload(
  instagramUrl: string | null | undefined,
): string | null {
  return instagramHandleFromUrl(instagramUrl);
}

export function buildConsumerBillPayload(
  place: {
    name: string;
    photos?: string[] | null;
    slug?: string | null;
    monthly_promo_cap?: number | null;
    instagram_url?: string | null;
  },
  calc: InformalBillCalc,
  projectId: string,
): Record<string, unknown> {
  const discount = calc.discountCents ?? 0;
  return {
    project_id: projectId,
    place_slug: place.slug ?? null,
    place_name: place.name,
    place_photo_url: place.photos?.[0] ?? null,
    place_instagram_handle: placeInstagramHandleForPayload(place.instagram_url),
    check_subtotal_cents: calc.subtotal,
    tip_cents: calc.tip,
    total_cents: calc.total,
    discount_cents: discount,
    discount_percent: calc.discountPercent,
    total_reward_cents: discount,
    reward_cap_mxn: place.monthly_promo_cap ?? null,
    amount_due_cents: calc.amountDueCents,
    currency: "MXN",
  };
}

/**
 * Close a reward ticket: reveal it (idempotent) and stamp the close time.
 * Discounts only — the reward was applied at the bill, so closing is just a
 * state flip; there is no payment to settle.
 */
export async function finalizeInformalTicket(
  admin: SupabaseClient,
  ticketId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ticket = await admin
    .from("tickets")
    .select("id, status")
    .eq("id", ticketId)
    .maybeSingle();
  if (ticket.error || !ticket.data) {
    return { ok: false, error: ticket.error?.message ?? "ticket not found" };
  }
  if (ticket.data.status === "revealed") return { ok: true };

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

  return { ok: true };
}

/** Reveal a ticket and queue the consumer's review prompt. */
export async function closeTicketAndEnqueueReview(
  admin: SupabaseClient,
  ticketId: string,
  consumerId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fin = await finalizeInformalTicket(admin, ticketId);
  if (!fin.ok) return fin;
  await ensureConsumerReviewNotification(admin, consumerId, ticketId, projectId);
  return { ok: true };
}

const REVIEW_READY_STATUSES = new Set(["revealed", "awaiting_story"]);

/** Ensure the review inbox row exists before the consumer submits a review. */
export async function prepareTicketForReview(
  admin: SupabaseClient,
  ticketId: string,
  consumerId: string,
): Promise<{ ok: true; projectId: string } | { ok: false; error: string }> {
  const ticket = await admin
    .from("tickets")
    .select("id, project_id, status")
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
      row.project_id,
    );
    return { ok: true, projectId: row.project_id };
  }

  return { ok: false, error: "Ticket is not ready for review" };
}

export async function ensureConsumerReviewNotification(
  admin: SupabaseClient,
  consumerId: string,
  ticketId: string,
  projectId: string,
): Promise<void> {
  const existing = await admin
    .from("consumer_pay_notifications")
    .select("id")
    .eq("ticket_id", ticketId)
    .eq("consumer_id", consumerId)
    .eq("kind", "review")
    .maybeSingle();
  if (existing.data) return;

  const [placeRes, ticketRes] = await Promise.all([
    admin
      .from("projects_view")
      .select("name, slug, photos, instagram_url")
      .eq("id", projectId)
      .single(),
    admin
      .from("tickets")
      .select(
        "kind, discount_cents, discount_percent, total_cents, check_subtotal_cents, tip_cents",
      )
      .eq("id", ticketId)
      .single(),
  ]);

  const v = placeRes.data;
  const t = ticketRes.data;
  const discount = t?.discount_cents ?? 0;

  await admin.from("consumer_pay_notifications").insert({
    consumer_id: consumerId,
    ticket_id: ticketId,
    kind: "review",
    status: "pending",
    payload: {
      project_id: projectId,
      place_slug: v?.slug ?? null,
      place_name: v?.name ?? "Partner place",
      place_photo_url: v?.photos?.[0] ?? null,
      place_instagram_handle: placeInstagramHandleForPayload(v?.instagram_url),
      ticket_kind: t?.kind ?? null,
      check_subtotal_cents: t?.check_subtotal_cents ?? null,
      tip_cents: t?.tip_cents ?? null,
      discount_cents: discount,
      discount_percent: t?.discount_percent ?? null,
      total_reward_cents: discount,
      total_cents: t?.total_cents ?? null,
      currency: "MXN",
    },
  });
}
