// Supabase Edge Function — business-mark-paid
//
// Authenticated. Transitions a FORMAL ticket from 'pending_pay' to either
// 'paid' (cashback can land now) or 'awaiting_story' (paid but story still
// needs verification). The function also runs the redemption + earn ledger
// rows when cashback is ready to credit.
//
// Story gating:
//   - kinds with a story step (s_p_sf_c, r_s_p_sf_c) only credit cashback
//     when story_status is already verified (ai_verified or waiter_verified).
//     If the story is still pending/submitted/ai_rejected, the ticket
//     moves to 'awaiting_story' and the credit happens later via
//     business-verify-story.
//   - kinds without a story step (p_c, r_p_c) credit cashback immediately
//     on mark-paid.
//
// Informal kinds are not expected here — they settle at create-time in
// business-create-ticket (status goes straight to 'revealed' and the
// redemption is applied inline). If one slips through (e.g. a future
// Stripe webhook fires on an informal ticket), we still reject below.
//
// Authorisation: either a venue_member of the ticket's venue OR the
// ticket's consumer can call this. (In v0 the validator marks paid manually;
// once a Stripe webhook is wired up that webhook becomes the trusted
// caller and this function becomes the shared write path.)
//
// Self-contained: own auth, own DB writes via service role, no Edge-to-Edge.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  checkMembership,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { FORMAL_KINDS, STORY_KINDS } from "../_shared/ticket-kinds.ts";
import { finalizeFormalTicketPayment } from "../_shared/ticket-formal-mark-paid.ts";

type Body = { ticketId?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const ticketId = (body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select(
      "id, venue_id, consumer_id, kind, status, story_status, total_cents, cashback_cents, cashback_percent, redeem_cents, paid_at",
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketRow.error) {
    return json(
      { ok: false, error: `ticket_lookup: ${ticketRow.error.message}` },
      500,
    );
  }
  if (!ticketRow.data) return json({ ok: false, error: "Ticket not found" }, 404);
  const ticket = ticketRow.data;

  // Authorisation: venue member OR the ticket's consumer.
  let authorised = ticket.consumer_id === userId;
  if (!authorised) {
    const m = await checkMembership(admin, authRes.user, ticket.venue_id);
    authorised = m.isSuperAdmin || m.role != null;
  }
  if (!authorised) {
    return json({ ok: false, error: "Not authorised for this ticket" }, 403);
  }

  // Idempotency: 'paid' and 'awaiting_story' are both post-payment states.
  if (ticket.status === "paid") {
    return json({ ok: true, ticket, alreadyPaid: true });
  }
  if (ticket.status === "awaiting_story") {
    // Already paid, just waiting on story. No-op; surface that to the caller.
    return json({ ok: true, ticket, alreadyPaid: true, awaitingStory: true });
  }
  if (ticket.status !== "pending_pay") {
    if (ticket.status !== "awaiting_payment_confirm") {
      return json(
        { ok: false, error: `Cannot mark ${ticket.status} ticket as paid` },
        409,
      );
    }
  }

  // Mock mode: informal and any other non-formal kinds are allowed.
  const paidAt = new Date().toISOString();

  // Staff marks payment on their side; ticket moves forward once consumer
  // confirms (or immediately for non-confirm flows in the consumer mock path).
  if (!FORMAL_KINDS.has(ticket.kind)) {
    const staffMarked = await admin
      .from("tickets")
      .update({ staff_payment_confirmed_at: paidAt })
      .eq("id", ticketId)
      .select("id, status, staff_payment_confirmed_at, consumer_payment_confirmed_at")
      .single();
    if (staffMarked.error) {
      return json(
        { ok: false, error: `ticket_update: ${staffMarked.error.message}` },
        500,
      );
    }
    return json({
      ok: true,
      ticket: staffMarked.data,
      awaitingConsumer: !staffMarked.data.consumer_payment_confirmed_at,
      awaitingStory: STORY_KINDS.has(ticket.kind),
    });
  }

  const result = await finalizeFormalTicketPayment(admin, ticket);
  if (!result.ok) {
    return json(
      { ok: false, error: result.error, code: result.code },
      result.status ?? 500,
    );
  }

  return json({
    ok: true,
    ticket: result.ticket,
    alreadyPaid: result.alreadyPaid,
    cashbackCreditedCents: result.cashbackCreditedCents,
    cashbackRedeemedCents: result.cashbackRedeemedCents,
    consumerBalanceAfterCents: result.consumerBalanceAfterCents,
    awaitingStory: result.awaitingStory ?? false,
  });
});
