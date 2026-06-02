// Staff WhatsApp orchestration — Ticket Type A (dp, informal, no story).
//
// Business rule: one WhatsApp number → exactly one active venue at a time.
// Staff may belong to many units; they must pick (or SWITCH) before guest codes.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { displayConsumerCode } from "./consumer-code.ts";
import { parseStaffWhatsAppMessage } from "./staff-llm.ts";
import { replyStaffCoach } from "./staff-whatsapp-replies.ts";
import {
  computeInformalBill,
  finalizeInformalTicket,
  formatMoneyMx,
  type ConsumerRow,
  type VenueRateRow,
} from "./ticket-informal.ts";
import { sendWhatsAppText, type TwilioEnv } from "./twilio.ts";

export type StaffVenue = {
  venueId: string;
  venueName: string;
};

export type StaffIdentity = {
  staffUserId: string;
  phoneE164: string;
  venues: StaffVenue[];
};

type StaffContext = StaffIdentity & {
  venueId: string;
  venueName: string;
};

type SessionRow = {
  id: string;
  phone_e164: string;
  staff_user_id: string;
  venue_id: string | null;
  state: string;
  consumer_id: string | null;
  ticket_id: string | null;
  pending_consumer_code: string | null;
  context: Record<string, unknown>;
};

type VenueOption = { venue_id: string; name: string };

export async function handleStaffInboundMessage(opts: {
  admin: SupabaseClient;
  twilio: TwilioEnv;
  identity: StaffIdentity;
  body: string;
}): Promise<void> {
  const { admin, twilio, identity, body } = opts;
  const venues = identity.venues;

  let session = await loadSession(admin, identity.phoneE164);

  if (isSwitchVenueCommand(body)) {
    if (session && session.state !== "idle" && session.state !== "selecting_venue") {
      await reply(
        twilio,
        identity.phoneE164,
        "Finish or CANCEL the current guest session before switching unit.",
      );
      return;
    }
    if (venues.length < 2) {
      await reply(
        twilio,
        identity.phoneE164,
        venues.length === 1
          ? `You're only on the team at ${venues[0].venueName}. No switch needed.`
          : "No venue on your staff profile.",
      );
      return;
    }
    session = await enterVenueSelection(admin, identity, session, venues);
    await reply(twilio, identity.phoneE164, venuePickerText(venues));
    return;
  }

  const sessionState = session?.state ?? "selecting_venue";
  const intent = await parseStaffWhatsAppMessage(body, sessionState);

  if (
    intent.intent === "help" &&
    (session?.state === "selecting_venue" || !session?.venue_id) &&
    venues.length > 1
  ) {
    await reply(twilio, identity.phoneE164, venuePickerText(venues));
    return;
  }

  if (intent.intent === "select_venue" && intent.venue_index != null) {
    const picked = venues[intent.venue_index];
    if (picked) {
      session = await applyActiveVenue(admin, identity, session, picked);
      await reply(
        twilio,
        identity.phoneE164,
        `Active unit: ${picked.venueName} ✓\nSend the guest's Mesita code (0000-0000).`,
      );
      return;
    }
    await reply(
      twilio,
      identity.phoneE164,
      await replyStaffCoach({
        sessionState: "selecting_venue",
        venueName: null,
        multiVenue: venues.length > 1,
        userMessage: body,
        situation: "invalid_venue_pick",
      }),
    );
    return;
  }

  const venuePick = parseVenueSelection(body, venues);
  if (
    venuePick &&
    (session?.state === "selecting_venue" || !session?.venue_id)
  ) {
    const picked = venues.find((v) => v.venueId === venuePick)!;
    session = await applyActiveVenue(admin, identity, session, picked);
    await reply(
      twilio,
      identity.phoneE164,
      `Active unit: ${picked.venueName} ✓\nSend the guest's Mesita code (0000-0000).`,
    );
    return;
  }

  const resolved = await resolveActiveVenue(admin, identity, session);
  if (resolved.kind === "need_selection") {
    session = resolved.session;
    const unclear =
      intent.intent === "unknown" &&
      !parseVenueSelection(body, venues) &&
      intent.venue_index == null;
    if (unclear && body.trim().length > 0) {
      await reply(
        twilio,
        identity.phoneE164,
        await replyStaffCoach({
          sessionState: "selecting_venue",
          venueName: null,
          multiVenue: venues.length > 1,
          userMessage: body,
        }),
      );
    } else {
      await reply(twilio, identity.phoneE164, venuePickerText(venues));
    }
    return;
  }

  const staff = resolved.staff;
  session = resolved.session;

  if (intent.intent === "cancel") {
    await resetSession(admin, session.id, staff.venueId);
    await reply(
      twilio,
      staff.phoneE164,
      `Session cleared at ${staff.venueName}.\nSend a guest code (0000-0000) when ready.\n` +
        (venues.length > 1 ? "SWITCH to change unit." : ""),
    );
    return;
  }

  if (intent.intent === "help") {
    await reply(
      twilio,
      staff.phoneE164,
      helpText(session.state, staff, venues, venues.length > 1),
    );
    return;
  }

  if (intent.intent === "lookup_code" && intent.consumer_code) {
    await handleLookupCode(admin, twilio, staff, session, intent.consumer_code);
    return;
  }

  if (
    intent.intent === "submit_bill" &&
    session.state === "consumer_identified" &&
    session.consumer_id &&
    intent.check_subtotal_cents != null
  ) {
    await handleSubmitBill(admin, twilio, staff, session, {
      subtotal: intent.check_subtotal_cents,
      tip: intent.tip_cents ?? 0,
    });
    return;
  }

  if (
    intent.intent === "confirm_payment" &&
    session.ticket_id &&
    (intent.confirm === true || intent.confirm === null)
  ) {
    await handleStaffPaymentConfirm(admin, twilio, staff, session);
    return;
  }

  if (intent.consumer_code && session.state === "idle") {
    await handleLookupCode(admin, twilio, staff, session, intent.consumer_code);
    return;
  }

  if (
    intent.intent === "submit_bill" &&
    session.state === "consumer_identified" &&
    intent.check_subtotal_cents == null
  ) {
    await reply(
      twilio,
      staff.phoneE164,
      await replyStaffCoach({
        sessionState: session.state,
        venueName: staff.venueName,
        multiVenue: venues.length > 1,
        userMessage: body,
        situation: "consumer_identified",
      }),
    );
    return;
  }

  if (
    intent.intent === "lookup_code" &&
    !intent.consumer_code &&
    session.state === "idle"
  ) {
    await reply(
      twilio,
      staff.phoneE164,
      await replyStaffCoach({
        sessionState: "idle",
        venueName: staff.venueName,
        multiVenue: venues.length > 1,
        userMessage: body,
      }),
    );
    return;
  }

  await reply(
    twilio,
    staff.phoneE164,
    await replyStaffCoach({
      sessionState: session.state,
      venueName: staff.venueName,
      multiVenue: venues.length > 1,
      userMessage: body,
    }),
  );
}

function prefixActiveVenue(staff: StaffContext): string {
  return `Unit: ${staff.venueName}\n`;
}

function helpText(
  state: string,
  staff: StaffContext,
  venues: StaffVenue[],
  canSwitch: boolean,
): string {
  const switchLine = canSwitch
    ? "SWITCH — change active unit (only when idle).\n"
    : "";
  switch (state) {
    case "selecting_venue":
      return venuePickerText(venues);
    case "consumer_identified":
      return (
        prefixActiveVenue(staff) +
        "Enter the bill:\n" +
        "• SUBTOTAL 850 TIP 100\n" +
        "• or two numbers: 850 100 (subtotal tip)\n" +
        "Amounts in pesos. CANCEL to start over."
      );
    case "awaiting_staff_payment_confirm":
      return prefixActiveVenue(staff) +
        "Reply CONFIRM or YES when the guest has paid their share.";
    default:
      return (
        prefixActiveVenue(staff) +
        "Mesita Staff — Type A (discount)\n" +
        "1) Send guest code (0000-0000)\n" +
        "2) Enter SUBTOTAL and TIP\n" +
        "3) Guest confirms in the Mesita app\n" +
        "4) You reply CONFIRM when paid\n" +
        switchLine +
        "CANCEL resets the guest session (keeps this unit)."
      );
  }
}

function venuePickerText(venues: StaffVenue[]): string {
  const lines = venues.map((v, i) => `${i + 1}) ${v.venueName}`);
  return (
    "You work at multiple Mesita units.\n" +
    "Pick where you're working now (one unit per WhatsApp number):\n\n" +
    lines.join("\n") +
    "\n\nReply with the number (e.g. 1) or the venue name.\n" +
    "Type SWITCH later to change unit (when no guest session is open)."
  );
}

function isSwitchVenueCommand(body: string): boolean {
  return /^(switch|unidad|sucursal|cambiar|venue|unit)\b/i.test(body.trim());
}

function parseVenueSelection(body: string, venues: StaffVenue[]): string | null {
  const t = body.trim();
  if (!t) return null;

  const numOnly = t.match(/^(\d+)$/);
  if (numOnly) {
    const idx = Number(numOnly[1]) - 1;
    if (idx >= 0 && idx < venues.length) return venues[idx].venueId;
  }

  const numPrefix = t.match(/^(?:venue|unidad|sucursal|unit)\s*#?\s*(\d+)/i);
  if (numPrefix) {
    const idx = Number(numPrefix[1]) - 1;
    if (idx >= 0 && idx < venues.length) return venues[idx].venueId;
  }

  const lower = t.toLowerCase();
  for (const v of venues) {
    const name = v.venueName.toLowerCase();
    if (lower === name || lower.includes(name) || name.includes(lower)) {
      return v.venueId;
    }
  }
  return null;
}

async function loadSession(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<SessionRow | null> {
  const existing = await admin
    .from("staff_whatsapp_sessions")
    .select("*")
    .eq("phone_e164", phoneE164)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  return existing.data ? (existing.data as SessionRow) : null;
}

async function enterVenueSelection(
  admin: SupabaseClient,
  identity: StaffIdentity,
  session: SessionRow | null,
  venues: StaffVenue[],
): Promise<SessionRow> {
  const options: VenueOption[] = venues.map((v) => ({
    venue_id: v.venueId,
    name: v.venueName,
  }));

  if (session) {
    const updated = await admin
      .from("staff_whatsapp_sessions")
      .update({
        state: "selecting_venue",
        venue_id: null,
        consumer_id: null,
        ticket_id: null,
        pending_consumer_code: null,
        context: { venue_options: options },
      })
      .eq("id", session.id)
      .select("*")
      .single();
    if (updated.error) throw new Error(updated.error.message);
    return updated.data as SessionRow;
  }

  const inserted = await admin
    .from("staff_whatsapp_sessions")
    .insert({
      phone_e164: identity.phoneE164,
      staff_user_id: identity.staffUserId,
      venue_id: null,
      state: "selecting_venue",
      context: { venue_options: options },
    })
    .select("*")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  return inserted.data as SessionRow;
}

async function applyActiveVenue(
  admin: SupabaseClient,
  identity: StaffIdentity,
  session: SessionRow | null,
  venue: StaffVenue,
): Promise<SessionRow> {
  if (session) {
    const updated = await admin
      .from("staff_whatsapp_sessions")
      .update({
        venue_id: venue.venueId,
        state: "idle",
        staff_user_id: identity.staffUserId,
        consumer_id: null,
        ticket_id: null,
        pending_consumer_code: null,
        context: {},
      })
      .eq("id", session.id)
      .select("*")
      .single();
    if (updated.error) throw new Error(updated.error.message);
    return updated.data as SessionRow;
  }

  const inserted = await admin
    .from("staff_whatsapp_sessions")
    .insert({
      phone_e164: identity.phoneE164,
      staff_user_id: identity.staffUserId,
      venue_id: venue.venueId,
      state: "idle",
    })
    .select("*")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  return inserted.data as SessionRow;
}

async function resolveActiveVenue(
  admin: SupabaseClient,
  identity: StaffIdentity,
  session: SessionRow | null,
): Promise<
  | { kind: "ok"; staff: StaffContext; session: SessionRow }
  | { kind: "need_selection"; session: SessionRow }
> {
  const venues = identity.venues;
  if (venues.length === 0) {
    throw new Error("staff has no venue_roles");
  }

  if (venues.length === 1) {
    const sessionOut = await applyActiveVenue(admin, identity, session, venues[0]);
    return {
      kind: "ok",
      staff: { ...identity, ...venues[0] },
      session: sessionOut,
    };
  }

  if (!session) {
    const created = await enterVenueSelection(admin, identity, null, venues);
    return { kind: "need_selection", session: created };
  }

  if (session.state === "selecting_venue" || !session.venue_id) {
    return { kind: "need_selection", session };
  }

  const active = venues.find((v) => v.venueId === session.venue_id);
  if (!active) {
    const created = await enterVenueSelection(admin, identity, session, venues);
    return { kind: "need_selection", session: created };
  }

  if (session.staff_user_id !== identity.staffUserId) {
    await admin
      .from("staff_whatsapp_sessions")
      .update({ staff_user_id: identity.staffUserId })
      .eq("id", session.id);
  }

  return {
    kind: "ok",
    staff: { ...identity, ...active },
    session,
  };
}

async function resetSession(
  admin: SupabaseClient,
  sessionId: string,
  venueId: string | null,
) {
  await admin
    .from("staff_whatsapp_sessions")
    .update({
      state: venueId ? "idle" : "selecting_venue",
      consumer_id: null,
      ticket_id: null,
      pending_consumer_code: null,
      context: {},
    })
    .eq("id", sessionId);
}

async function handleLookupCode(
  admin: SupabaseClient,
  twilio: TwilioEnv,
  staff: StaffContext,
  session: SessionRow,
  code: string,
) {
  const consumerRes = await admin
    .from("consumers")
    .select(
      "id, code, full_name, first_name, last_name, cashback_balance_cents, tier_key, tier_origin, consumer_instagram_followers_count, phone",
    )
    .eq("code", code)
    .maybeSingle();
  if (consumerRes.error || !consumerRes.data) {
    await reply(
      twilio,
      staff.phoneE164,
      `No guest found for code ${displayConsumerCode(code)}. Double-check and try again.`,
    );
    return;
  }
  const c = consumerRes.data as ConsumerRow;
  const subRes = await admin
    .from("consumer_subscriptions")
    .select("status, current_period_end")
    .eq("consumer_id", c.id)
    .eq("status", "active")
    .maybeSingle();

  const name = c.full_name ||
    [c.first_name, c.last_name].filter(Boolean).join(" ") ||
    "Guest";
  const tier = c.tier_key ?? "free";
  const ig = c.consumer_instagram_followers_count;
  const igLine = ig != null ? `\nInstagram followers: ${ig}` : "";
  const subLine = subRes.data
    ? `\nSubscription: active`
    : `\nSubscription: none (${c.tier_origin ?? "default"})`;

  await admin
    .from("staff_whatsapp_sessions")
    .update({
      state: "consumer_identified",
      consumer_id: c.id,
      pending_consumer_code: code,
      ticket_id: null,
      context: { consumer_preview: { name, tier } },
    })
    .eq("id", session.id);

  await reply(
    twilio,
    staff.phoneE164,
    `Guest verified ✓\n` +
      `Code: ${displayConsumerCode(code)}\n` +
      `Name: ${name}\n` +
      `ID: ${c.id.slice(0, 8)}…\n` +
      `Tier: ${tier}${igLine}${subLine}\n` +
      `Balance: ${formatMoneyMx(c.cashback_balance_cents ?? 0)}\n\n` +
      `Unit: ${staff.venueName}\n` +
      `(Discount applies for this venue only.)\n\n` +
      `Reply with bill amounts:\n` +
      `SUBTOTAL <pesos> TIP <pesos>\n` +
      `Example: SUBTOTAL 850 TIP 100`,
  );
}

async function handleSubmitBill(
  admin: SupabaseClient,
  twilio: TwilioEnv,
  staff: StaffContext,
  session: SessionRow,
  amounts: { subtotal: number; tip: number },
) {
  if (!session.consumer_id) return;

  const venueRes = await admin
    .from("venues")
    .select(
      "id, name, cashback_percent, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, monthly_promo_cap, listing_type, status, fiscal_type",
    )
    .eq("id", staff.venueId)
    .maybeSingle();
  if (venueRes.error || !venueRes.data) {
    await reply(twilio, staff.phoneE164, "Venue not found.");
    return;
  }
  const venue = venueRes.data as VenueRateRow;
  if (venue.fiscal_type !== "informal") {
    await reply(
      twilio,
      staff.phoneE164,
      "This venue uses cashback (formal) — discount Type A isn't available here.",
    );
    return;
  }
  if (venue.listing_type !== "partner") {
    await reply(twilio, staff.phoneE164, "Venue must be a verified partner.");
    return;
  }

  const consumerRes = await admin
    .from("consumers")
    .select(
      "id, code, full_name, first_name, last_name, cashback_balance_cents, tier_key, tier_origin, consumer_instagram_followers_count, phone",
    )
    .eq("id", session.consumer_id)
    .single();
  if (consumerRes.error) {
    await reply(twilio, staff.phoneE164, "Guest record error.");
    return;
  }

  const calc = await computeInformalBill(
    admin,
    venue,
    consumerRes.data as ConsumerRow,
    amounts.subtotal,
    amounts.tip,
    0,
  );

  if (calc.subtotal === 0) {
    await reply(twilio, staff.phoneE164, "Check total can't be zero.");
    return;
  }

  const opener = await resolveTicketOpener(admin, staff.venueId, staff.staffUserId);

  const insert = await admin
    .from("tickets")
    .insert({
      venue_id: staff.venueId,
      consumer_id: session.consumer_id,
      opened_by: opener,
      opened_by_staff_user_id: staff.staffUserId,
      kind: "dp",
      status: "awaiting_payment_confirm",
      story_status: "not_required",
      check_subtotal_cents: calc.subtotal,
      tip_cents: calc.tip,
      total_cents: calc.total,
      cashback_percent: 0,
      cashback_cents: 0,
      redeem_cents: calc.redeemCents,
      discount_percent: calc.discountPercent,
      discount_cents: calc.discountCents,
    })
    .select("id")
    .single();
  if (insert.error) {
    await reply(
      twilio,
      staff.phoneE164,
      `Couldn't open ticket: ${insert.error.message}`,
    );
    return;
  }

  const ticketId = insert.data.id;
  const payload = {
    venue_name: venue.name,
    check_subtotal_cents: calc.subtotal,
    tip_cents: calc.tip,
    total_cents: calc.total,
    discount_cents: calc.discountCents,
    discount_percent: calc.discountPercent,
    redeem_cents: calc.redeemCents,
    amount_due_cents: calc.amountDueCents,
    currency: "MXN",
  };

  await admin.from("consumer_pay_notifications").insert({
    consumer_id: session.consumer_id,
    ticket_id: ticketId,
    kind: "payment_confirm",
    status: "pending",
    payload,
  });

  await admin
    .from("staff_whatsapp_sessions")
    .update({
      state: "awaiting_staff_payment_confirm",
      ticket_id: ticketId,
      context: { bill: payload },
    })
    .eq("id", session.id);

  const guestPhone = consumerRes.data.phone;
  if (guestPhone) {
    await sendWhatsAppText({
      env: twilio,
      from: twilio.whatsappFromConsumers,
      to: guestPhone,
      body:
        `Mesita — payment at ${venue.name}\n` +
        `Bill: ${formatMoneyMx(calc.total)}\n` +
        `Discount (${calc.discountPercent}%): -${formatMoneyMx(calc.discountCents)}\n` +
        (calc.redeemCents > 0
          ? `Balance applied: -${formatMoneyMx(calc.redeemCents)}\n`
          : "") +
        `Amount due: ${formatMoneyMx(calc.amountDueCents)}\n\n` +
        `Confirm payment in the Mesita app → Pay tab.`,
    });
  }

  await reply(
    twilio,
    staff.phoneE164,
    `Bill calculated ✓ (${staff.venueName})\n` +
      `Subtotal: ${formatMoneyMx(calc.subtotal)}\n` +
      `Tip: ${formatMoneyMx(calc.tip)}\n` +
      `Discount (${calc.discountPercent}%): -${formatMoneyMx(calc.discountCents)}\n` +
      (calc.redeemCents > 0
        ? `Mesita balance: -${formatMoneyMx(calc.redeemCents)}\n`
        : "") +
      `Guest pays: ${formatMoneyMx(calc.amountDueCents)}\n\n` +
      `Passive payment: collect ${formatMoneyMx(calc.amountDueCents)} in cash/card off-rail.\n` +
      `Guest confirms in the Mesita app. Reply CONFIRM when they've paid.`,
  );
}

async function handleStaffPaymentConfirm(
  admin: SupabaseClient,
  twilio: TwilioEnv,
  staff: StaffContext,
  session: SessionRow,
) {
  if (!session.ticket_id || !session.consumer_id) return;

  const now = new Date().toISOString();
  await admin
    .from("tickets")
    .update({ staff_payment_confirmed_at: now })
    .eq("id", session.ticket_id);

  const ticket = await admin
    .from("tickets")
    .select("consumer_payment_confirmed_at, status")
    .eq("id", session.ticket_id)
    .single();

  if (ticket.data?.consumer_payment_confirmed_at) {
    const done = await tryFinalizeAndReview(
      admin,
      session.ticket_id,
      session.consumer_id,
      staff.venueId,
    );
    if (!done.ok) {
      await reply(twilio, staff.phoneE164, `Error finalizing: ${done.error}`);
      return;
    }
    await resetSession(admin, session.id, staff.venueId);
    await reply(
      twilio,
      staff.phoneE164,
      "Payment recorded ✓ Ticket closed. Guest will get a review prompt in the app.",
    );
    return;
  }

  await admin
    .from("staff_whatsapp_sessions")
    .update({ state: "awaiting_staff_payment_confirm" })
    .eq("id", session.id);

  await reply(
    twilio,
    staff.phoneE164,
    "Your confirmation is saved. Waiting for the guest to confirm in the Mesita app.",
  );
}

export async function onConsumerPaymentConfirmed(
  admin: SupabaseClient,
  twilio: TwilioEnv | null,
  ticketId: string,
  consumerId: string,
): Promise<void> {
  const ticket = await admin
    .from("tickets")
    .select(
      "id, venue_id, staff_payment_confirmed_at, status, opened_by_staff_user_id",
    )
    .eq("id", ticketId)
    .eq("consumer_id", consumerId)
    .maybeSingle();
  if (!ticket.data || ticket.data.status !== "awaiting_payment_confirm") return;

  const venueRes = await admin
    .from("venues")
    .select("name")
    .eq("id", ticket.data.venue_id)
    .single();

  if (ticket.data.staff_payment_confirmed_at) {
    await tryFinalizeAndReview(
      admin,
      ticketId,
      consumerId,
      ticket.data.venue_id,
    );

    if (twilio && ticket.data.opened_by_staff_user_id) {
      const staffPhone = await staffPhoneForUser(
        admin,
        ticket.data.opened_by_staff_user_id,
      );
      if (staffPhone) {
        await sendWhatsAppText({
          env: twilio,
          from: twilio.whatsappFromStaff,
          to: staffPhone,
          body:
            `Guest confirmed payment at ${venueRes.data?.name ?? "your venue"} ✓\n` +
            `Reply CONFIRM when you've collected payment.`,
        });
      }
    }
    return;
  }

  if (twilio && ticket.data.opened_by_staff_user_id) {
    const staffPhone = await staffPhoneForUser(
      admin,
      ticket.data.opened_by_staff_user_id,
    );
    if (staffPhone) {
      await sendWhatsAppText({
        env: twilio,
        from: twilio.whatsappFromStaff,
        to: staffPhone,
        body:
          `Guest confirmed payment in the app (${venueRes.data?.name ?? "venue"}).\n` +
          `Reply CONFIRM when payment is collected.`,
      });
    }
  }
}

async function tryFinalizeAndReview(
  admin: SupabaseClient,
  ticketId: string,
  consumerId: string,
  venueId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fin = await finalizeInformalTicket(admin, ticketId, consumerId, venueId);
  if (!fin.ok) return fin;
  await enqueueReview(admin, consumerId, ticketId, venueId);
  return { ok: true };
}

async function enqueueReview(
  admin: SupabaseClient,
  consumerId: string,
  ticketId: string,
  venueId: string,
) {
  const venue = await admin.from("venues").select("name").eq("id", venueId)
    .single();
  await admin.from("consumer_pay_notifications").insert({
    consumer_id: consumerId,
    ticket_id: ticketId,
    kind: "review",
    status: "pending",
    payload: { venue_name: venue.data?.name ?? "Partner venue" },
  });
}

async function resolveTicketOpener(
  admin: SupabaseClient,
  venueId: string,
  staffUserId: string,
): Promise<string> {
  const owner = await admin
    .from("venue_members")
    .select("business_id")
    .eq("venue_id", venueId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  if (owner.data?.business_id) return owner.data.business_id;
  return staffUserId;
}

async function staffPhoneForUser(
  admin: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const session = await admin
    .from("staff_whatsapp_sessions")
    .select("phone_e164")
    .eq("staff_user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (session.data?.phone_e164) return session.data.phone_e164;

  const { data } = await admin.auth.admin.getUserById(userId);
  const phone = data.user?.phone;
  if (!phone) return null;
  return phone.startsWith("+") ? phone : `+${phone}`;
}

async function reply(twilio: TwilioEnv, to: string, body: string) {
  await sendWhatsAppText({
    env: twilio,
    from: twilio.whatsappFromStaff,
    to,
    body,
  });
}

async function listStaffVenues(
  admin: SupabaseClient,
  userId: string,
): Promise<StaffVenue[]> {
  const roleRows = await admin
    .from("venue_roles")
    .select("venue_id, venues(name)")
    .eq("user_id", userId)
    .eq("role", "staff");
  if (roleRows.error || !roleRows.data?.length) return [];

  const venues: StaffVenue[] = [];
  for (const row of roleRows.data) {
    const join = row.venues as { name: string } | null;
    venues.push({
      venueId: row.venue_id,
      venueName: join?.name ?? "Venue",
    });
  }
  venues.sort((a, b) => a.venueName.localeCompare(b.venueName));
  return venues;
}

export type StaffAccess =
  | { status: "ok"; identity: StaffIdentity }
  | { status: "unknown_phone" }
  | { status: "not_on_team" };

/** Staff auth + venue team membership for this WhatsApp number. */
export async function resolveStaffAccess(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<StaffAccess> {
  const digits = phoneE164.replace(/\D/g, "");
  const userIdRes = await admin.rpc("find_user_id_by_phone", {
    phone_digits: digits,
  });
  const userId = userIdRes.data as string | null;
  if (!userId) return { status: "unknown_phone" };

  const venues = await listStaffVenues(admin, userId);
  if (venues.length === 0) return { status: "not_on_team" };

  return {
    status: "ok",
    identity: {
      staffUserId: userId,
      phoneE164,
      venues,
    },
  };
}

/** @deprecated Use resolveStaffAccess */
export async function resolveStaffIdentity(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<StaffIdentity | null> {
  const access = await resolveStaffAccess(admin, phoneE164);
  return access.status === "ok" ? access.identity : null;
}
