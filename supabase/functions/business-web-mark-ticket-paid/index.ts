// Supabase Edge Function — business-web-mark-ticket-paid
//
// Staff-only payment confirmation. The guest pays the discounted total at the
// table; staff tap "Paid received" here, which closes the ticket (revealed)
// and queues the consumer's review. Single confirmation — the consumer never
// confirms payment, and Mesita never touches the money.
//
// Authorisation: a place_member of the ticket's place (super-admins bypass via
// requireMembership). Self-contained: own auth, service-role writes.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { closeTicketAndEnqueueReview } from "../_shared/ticket-informal.ts";

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

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const ticketId = (bodyRes.body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select("id, project_id, consumer_id, status")
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

  const memberRes = await requireMembership(admin, authRes.user, ticket.project_id);
  if (!memberRes.ok) return memberRes.response;

  // Idempotent: already closed.
  if (ticket.status === "revealed") {
    return json({ ok: true, ticket, alreadyPaid: true });
  }
  if (ticket.status !== "awaiting_payment_confirm") {
    return json(
      {
        ok: false,
        error:
          ticket.status === "awaiting_story"
            ? "Confirm the guest's story before marking paid."
            : `Cannot mark a ${ticket.status} ticket as paid.`,
      },
      409,
    );
  }

  const closed = await closeTicketAndEnqueueReview(
    admin,
    ticketId,
    ticket.consumer_id,
    ticket.project_id,
  );
  if (!closed.ok) {
    return json({ ok: false, error: `ticket_close: ${closed.error}` }, 500);
  }

  return json({ ok: true, ticketId, status: "revealed" });
});
