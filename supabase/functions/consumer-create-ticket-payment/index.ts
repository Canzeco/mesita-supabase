// Supabase Edge Function — consumer-create-ticket-payment
//
// Authenticated consumer. Starts Stripe Embedded Checkout for a formal
// ticket in pending_pay (cashback flows C/D). Returns client_secret for
// @stripe/react-stripe-js Embedded Checkout, or mock: true when billing is
// in demo mode (same toggle pattern as consumer-create-subscription).
//
// Body: { ticketId: string, returnUrl?: string }
// Response: { ok: true, client_secret?: string, mock?: true }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { FORMAL_KINDS } from "../_shared/ticket-kinds.ts";

type Body = { ticketId?: string; returnUrl?: string };

const MOCK_TICKET_PAYMENT =
  (Deno.env.get("MOCK_TICKET_PAYMENT") ?? "true").toLowerCase() !== "false";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const consumerId = authRes.user.id;

  const body = await readJsonOr<Body>(req, {});
  const ticketId = (body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select(
      "id, consumer_id, venue_id, kind, status, total_cents, currency",
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

  if (ticket.consumer_id !== consumerId) {
    return json({ ok: false, error: "Not your ticket" }, 403);
  }
  if (!FORMAL_KINDS.has(ticket.kind)) {
    return json(
      { ok: false, error: "This visit does not use online payment" },
      400,
    );
  }
  if (ticket.status !== "pending_pay") {
    return json(
      {
        ok: false,
        error:
          ticket.status === "paid" || ticket.status === "awaiting_story"
            ? "already_paid"
            : `Ticket is ${ticket.status}, not ready to pay`,
      },
      ticket.status === "paid" || ticket.status === "awaiting_story" ? 409 : 409,
    );
  }

  const amountCents = ticket.total_cents ?? 0;
  if (amountCents < 1) {
    return json({ ok: false, error: "Invalid ticket amount" }, 400);
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (MOCK_TICKET_PAYMENT || !stripeKey) {
    return json({ ok: true, mock: true });
  }

  const venueRow = await admin
    .from("venues")
    .select("name")
    .eq("id", ticket.venue_id)
    .maybeSingle();
  const venueName = (venueRow.data?.name as string | undefined) ?? "Restaurant";

  const stripe = new Stripe(stripeKey, { apiVersion: "2025-03-31.basil" });

  const { data: existing } = await admin
    .from("consumer_subscriptions")
    .select("stripe_customer_id")
    .eq("consumer_id", consumerId)
    .not("stripe_customer_id", "is", null)
    .limit(1)
    .maybeSingle();

  let customerId = existing?.stripe_customer_id ?? null;
  if (!customerId || customerId.startsWith("mock_")) {
    const customer = await stripe.customers.create({
      metadata: { consumer_id: consumerId },
    });
    customerId = customer.id;
  }

  const origin = req.headers.get("origin") ?? "";
  const returnUrl =
    body.returnUrl ??
    `${origin}/pay/ticket/${ticketId}?stripe_return=1`;

  const currency = ((ticket.currency as string | null) ?? "MXN").toLowerCase();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    ui_mode: "embedded",
    customer: customerId,
    client_reference_id: consumerId,
    line_items: [
      {
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: {
            name: `Mesita · ${venueName}`,
            description: "Visit payment",
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      purpose: "ticket_payment",
      ticket_id: ticketId,
      consumer_id: consumerId,
      venue_id: ticket.venue_id,
    },
    return_url: returnUrl,
  });

  if (!session.client_secret) {
    return json({ ok: false, error: "Stripe session missing client_secret" }, 500);
  }

  return json({
    ok: true,
    client_secret: session.client_secret,
    session_id: session.id,
  });
});
