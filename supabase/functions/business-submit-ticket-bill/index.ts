// Supabase Edge Function — business-submit-ticket-bill
//
// Billing step after scan: attach check totals to an open ticket and move it
// to awaiting_payment_confirm (consumer Pay inbox notification).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { computeTicketBill } from "../_shared/business-ticket-billing.ts";
import {
  FORMAL_KINDS,
  STORY_KINDS,
} from "../_shared/ticket-kinds.ts";
import { isConsumerFirstVisit, selectVenueRate } from "../_shared/membership.ts";

type Body = {
  ticketId?: string;
  checkSubtotalCents?: number;
  tipCents?: number;
  redeemCents?: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const ticketId = (body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const subtotal = toCents(body.checkSubtotalCents);
  const tipRaw = toCents(body.tipCents ?? 0);
  const redeemRequested = toCents(body.redeemCents ?? 0);
  if (subtotal == null) {
    return json(
      { ok: false, error: "checkSubtotalCents must be a non-negative integer" },
      400,
    );
  }
  if (tipRaw == null) {
    return json(
      { ok: false, error: "tipCents must be a non-negative integer" },
      400,
    );
  }
  if (redeemRequested == null) {
    return json(
      { ok: false, error: "redeemCents must be a non-negative integer" },
      400,
    );
  }

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select(
      "id, venue_id, consumer_id, kind, status, check_subtotal_cents, total_cents, currency",
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketRow.error) {
    return json(
      { ok: false, error: `ticket_lookup: ${ticketRow.error.message}` },
      500,
    );
  }
  if (!ticketRow.data) {
    return json({ ok: false, error: "Ticket not found" }, 404);
  }
  const ticket = ticketRow.data;

  const memberRes = await requireMembership(admin, authRes.user, ticket.venue_id);
  if (!memberRes.ok) return memberRes.response;

  if (ticket.status !== "open") {
    return json(
      { ok: false, error: `Ticket is ${ticket.status} — billing only applies to open scans.` },
      409,
    );
  }
  if ((ticket.check_subtotal_cents ?? 0) > 0 || (ticket.total_cents ?? 0) > 0) {
    return json({ ok: false, error: "Bill already submitted for this ticket." }, 409);
  }

  const kind = ticket.kind;
  const isFormal = FORMAL_KINDS.has(kind);
  const requiresStory = STORY_KINDS.has(kind);
  const tip = isFormal ? tipRaw : 0;

  if (!isFormal && redeemRequested > 0) {
    return json(
      {
        ok: false,
        error: "Redemption isn't allowed on informal/discount tickets.",
      },
      400,
    );
  }

  const venueRow = await admin
    .from("venues")
    .select(
      "id, name, slug, photos, cashback_percent, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, monthly_promo_cap, status",
    )
    .eq("id", ticket.venue_id)
    .maybeSingle();
  if (venueRow.error || !venueRow.data) {
    return json({ ok: false, error: "Venue not found" }, 404);
  }
  const venue = venueRow.data;
  if (venue.status === "archived") {
    return json({ ok: false, error: "Venue is archived" }, 409);
  }

  const consumerRow = await admin
    .from("consumers")
    .select("id, cashback_balance_cents, tier_key")
    .eq("id", ticket.consumer_id)
    .maybeSingle();
  if (consumerRow.error || !consumerRow.data) {
    return json({ ok: false, error: "Consumer not found" }, 404);
  }

  const firstVisit = await isConsumerFirstVisit(admin, ticket.consumer_id, ticket.venue_id);
  const ratePercent = selectVenueRate(venue, consumerRow.data.tier_key, firstVisit);
  const capPesos = venue.monthly_promo_cap;

  const billRes = computeTicketBill({
    subtotal,
    tip,
    redeemRequested,
    isFormal,
    ratePercent,
    consumerBalance: consumerRow.data.cashback_balance_cents ?? 0,
    capPesos,
  });
  if (!billRes.ok) {
    return json({ ok: false, code: billRes.code, error: billRes.error }, 400);
  }
  const snap = billRes.snapshot;

  const storyStatus = requiresStory ? "pending" : "not_required";
  const status = "awaiting_payment_confirm";

  const update = await admin
    .from("tickets")
    .update({
      status,
      story_status: storyStatus,
      check_subtotal_cents: snap.checkSubtotalCents,
      tip_cents: snap.tipCents,
      total_cents: snap.totalCents,
      cashback_percent: snap.cashbackPercent,
      cashback_cents: snap.cashbackCents,
      redeem_cents: snap.redeemCents,
      discount_percent: snap.discountPercent,
      discount_cents: snap.discountCents,
    })
    .eq("id", ticketId)
    .eq("status", "open")
    .select(
      "id, kind, status, story_status, check_subtotal_cents, tip_cents, total_cents, cashback_percent, cashback_cents, redeem_cents, discount_percent, discount_cents, revealed_at, currency, created_at",
    )
    .single();
  if (update.error) {
    return json(
      { ok: false, error: `ticket_update: ${update.error.message}` },
      500,
    );
  }

  await admin.from("consumer_pay_notifications").insert({
    consumer_id: ticket.consumer_id,
    ticket_id: ticketId,
    kind: "payment_confirm",
    status: "pending",
    payload: {
      venue_id: venue.id,
      venue_slug: venue.slug ?? null,
      venue_name: venue.name,
      venue_photo_url: venue.photos?.[0] ?? null,
      ticket_kind: kind,
      check_subtotal_cents: snap.checkSubtotalCents,
      tip_cents: snap.tipCents,
      total_cents: snap.totalCents,
      discount_cents: isFormal ? 0 : (snap.discountCents ?? 0),
      discount_percent: isFormal ? 0 : (snap.discountPercent ?? 0),
      cashback_cents: isFormal ? snap.cashbackCents : 0,
      cashback_percent: isFormal ? ratePercent : 0,
      redeem_cents: snap.redeemCents,
      total_reward_cents: (isFormal ? snap.cashbackCents : (snap.discountCents ?? 0)) +
        snap.redeemCents,
      reward_cap_mxn: capPesos ?? null,
      amount_due_cents: snap.amountDueCents,
      currency: update.data.currency ?? "MXN",
    },
  });

  return json({ ok: true, ticket: update.data });
});

function toCents(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return Math.trunc(n);
}
