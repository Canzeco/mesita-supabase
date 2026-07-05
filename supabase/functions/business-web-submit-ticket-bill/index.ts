// Supabase Edge Function — business-web-submit-ticket-bill
//
// Billing step after scan: attach the check subtotal to an open ticket and
// snapshot the discount. The discount is applied right here, but the ticket
// closes only when staff confirm payment (business-web-mark-ticket-paid):
//   Type A (no story):  -> awaiting_payment_confirm
//   Type B (with story): -> awaiting_story (then awaiting_payment_confirm)
// The discounted bill is delivered to the consumer's Pay inbox either way.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { computeTicketBill } from "../_shared/business-ticket-billing.ts";
import { isConsumerFirstVisit, selectprojectRate } from "../_shared/membership.ts";
import { placeInstagramHandleForPayload } from "../_shared/ticket-informal.ts";
import { toCents } from "../_shared/money.ts";

type Body = {
  ticketId?: string;
  checkSubtotalCents?: number;
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
  if (subtotal == null) {
    return json(
      { ok: false, error: "checkSubtotalCents must be a non-negative integer" },
      400,
    );
  }

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select(
      "id, project_id, consumer_id, kind, story_status, status, check_subtotal_cents, total_cents, currency",
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

  const memberRes = await requireMembership(admin, authRes.user, ticket.project_id);
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
  // Story is orthogonal to `kind` (enum is reservation|coupon) — the story
  // requirement is carried by story_status, seeded at scan/create time.
  const requiresStory = ticket.story_status != null &&
    ticket.story_status !== "not_required";

  const placeRow = await admin
    .from("projects_view")
    .select(
      "id, name, slug, photos, instagram_url, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, monthly_promo_cap, status",
    )
    .eq("id", ticket.project_id)
    .maybeSingle();
  if (placeRow.error || !placeRow.data) {
    return json({ ok: false, error: "Place not found" }, 404);
  }
  const place = placeRow.data;
  if (place.status === "archived") {
    return json({ ok: false, error: "Place is archived" }, 409);
  }

  const consumerRow = await admin
    .from("consumers")
    .select("id, tier_key")
    .eq("id", ticket.consumer_id)
    .maybeSingle();
  if (consumerRow.error || !consumerRow.data) {
    return json({ ok: false, error: "Consumer not found" }, 404);
  }

  const firstVisit = await isConsumerFirstVisit(admin, ticket.consumer_id, ticket.project_id);
  const ratePercent = selectprojectRate(place, consumerRow.data.tier_key, firstVisit);
  const capPesos = place.monthly_promo_cap;

  const billRes = computeTicketBill({ subtotal, ratePercent, capPesos });
  if (!billRes.ok) {
    return json({ ok: false, code: billRes.code, error: billRes.error }, 400);
  }
  const snap = billRes.snapshot;

  // Type A goes straight to the staff payment-confirm gate; Type B waits for
  // the story to verify first. Either way the ticket closes only when staff
  // tap Paid received (business-web-mark-ticket-paid).
  const now = new Date().toISOString();
  const storyStatus = requiresStory ? "pending" : "not_required";
  const status = requiresStory ? "awaiting_story" : "awaiting_payment_confirm";

  const update = await admin
    .from("tickets")
    .update({
      status,
      story_status: storyStatus,
      check_subtotal_cents: snap.checkSubtotalCents,
      tip_cents: snap.tipCents,
      total_cents: snap.totalCents,
      redeem_cents: 0,
      discount_percent: snap.discountPercent,
      discount_cents: snap.discountCents,
    })
    .eq("id", ticketId)
    .eq("status", "open")
    .select(
      "id, kind, status, story_status, check_subtotal_cents, tip_cents, total_cents, discount_percent, discount_cents, revealed_at, currency, created_at",
    )
    .single();
  if (update.error) {
    return json(
      { ok: false, error: `ticket_update: ${update.error.message}` },
      500,
    );
  }

  // Deliver the discounted bill to the consumer's Pay inbox.
  await admin.from("consumer_pay_notifications").insert({
    consumer_id: ticket.consumer_id,
    ticket_id: ticketId,
    kind: "bill",
    status: "completed",
    resolved_at: now,
    payload: {
      project_id: place.id,
      place_slug: place.slug ?? null,
      place_name: place.name,
      place_photo_url: place.photos?.[0] ?? null,
      place_instagram_handle: placeInstagramHandleForPayload(place.instagram_url),
      ticket_kind: kind,
      check_subtotal_cents: snap.checkSubtotalCents,
      tip_cents: snap.tipCents,
      total_cents: snap.totalCents,
      discount_cents: snap.discountCents ?? 0,
      discount_percent: snap.discountPercent ?? 0,
      total_reward_cents: snap.discountCents ?? 0,
      reward_cap_mxn: capPesos ?? null,
      amount_due_cents: snap.amountDueCents,
      currency: update.data.currency ?? "MXN",
    },
  });

  // The review is queued only when staff confirm payment (business-web-mark-ticket-paid).
  return json({ ok: true, ticket: update.data });
});
