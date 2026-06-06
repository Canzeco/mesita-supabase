// Supabase Edge Function — business-mark-paid
//
// Authenticated. Staff marks a discount ticket's payment as received on their
// side (staff_payment_confirmed_at); the ticket settles once the consumer also
// confirms. Discounts only — Mesita never holds money, so there is no balance
// or credit step here.
//
// Authorisation: either a venue_member of the ticket's venue OR the ticket's
// consumer can call this.
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
import { STORY_KINDS } from "../_shared/ticket-kinds.ts";

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
  const ticketId = (bodyRes.body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select(
      "id, venue_id, consumer_id, kind, status, story_status, total_cents, paid_at",
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
    return json({ ok: true, ticket, alreadyPaid: true, awaitingStory: true });
  }
  if (
    ticket.status !== "pending_pay" &&
    ticket.status !== "awaiting_payment_confirm"
  ) {
    return json(
      { ok: false, error: `Cannot mark ${ticket.status} ticket as paid` },
      409,
    );
  }

  // Staff marks payment on their side; ticket moves forward once the consumer
  // confirms (or immediately for non-confirm flows in the consumer mock path).
  const paidAt = new Date().toISOString();
  const staffMarked = await admin
    .from("tickets")
    .update({ staff_payment_confirmed_at: paidAt })
    .eq("id", ticketId)
    .select(
      "id, status, staff_payment_confirmed_at, consumer_payment_confirmed_at",
    )
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
});
