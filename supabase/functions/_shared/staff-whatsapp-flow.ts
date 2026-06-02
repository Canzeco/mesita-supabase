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
import { sendStaffWhatsAppReply } from "./staff-whatsapp-messages.ts";
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
  conversationHistory?: string;
}): Promise<void> {
  const { admin, twilio, identity, body, conversationHistory = "" } = opts;
  const venues = identity.venues;

  let session = await loadSession(admin, identity.phoneE164);

  if (isSwitchVenueCommand(body)) {
    if (session && session.state !== "idle" && session.state !== "selecting_venue") {
      await reply(
        admin,
        twilio,
        identity.phoneE164,
        "Termina o escribe cancelar la sesión del comensal antes de cambiar de unidad.",
      );
      return;
    }
    if (venues.length < 2) {
      await reply(
        admin,
        twilio,
        identity.phoneE164,
        venues.length === 1
          ? `Solo estás en el equipo de ${venues[0].venueName}. No hace falta cambiar.`
          : "No tienes un restaurante asignado en tu perfil.",
      );
      return;
    }
    session = await enterVenueSelection(admin, identity, session, venues);
    await reply(admin, twilio, identity.phoneE164, venuePickerText(venues));
    return;
  }

  const sessionState = session?.state ?? "selecting_venue";
  const intent = await parseStaffWhatsAppMessage(
    body,
    sessionState,
    conversationHistory,
  );

  if (
    intent.intent === "help" &&
    (session?.state === "selecting_venue" || !session?.venue_id) &&
    venues.length > 1
  ) {
    await reply(admin, twilio, identity.phoneE164, venuePickerText(venues));
    return;
  }

  if (intent.intent === "select_venue" && intent.venue_index != null) {
    const picked = venues[intent.venue_index];
    if (picked) {
      session = await applyActiveVenue(admin, identity, session, picked);
      await reply(
        admin,
        twilio,
        identity.phoneE164,
        `Unidad activa: ${picked.venueName} ✓\nManda el código Mesita del comensal (0000-0000).`,
      );
      return;
    }
    await reply(
      admin,
      twilio,
      identity.phoneE164,
      await replyStaffCoach({
        sessionState: "selecting_venue",
        venueName: null,
        multiVenue: venues.length > 1,
        userMessage: body,
        situation: "invalid_venue_pick",
        conversationHistory,
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
      admin,
      twilio,
      identity.phoneE164,
      `Unidad activa: ${picked.venueName} ✓\nManda el código Mesita del comensal (0000-0000).`,
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
        admin,
        twilio,
        identity.phoneE164,
        await replyStaffCoach({
          sessionState: "selecting_venue",
          venueName: null,
          multiVenue: venues.length > 1,
          userMessage: body,
          conversationHistory,
        }),
      );
    } else {
      await reply(admin, twilio, identity.phoneE164, venuePickerText(venues));
    }
    return;
  }

  const staff = resolved.staff;
  session = resolved.session;

  if (intent.intent === "cancel") {
    await resetSession(admin, session.id, staff.venueId);
    await reply(
      admin,
      twilio,
      staff.phoneE164,
      `Sesión reiniciada en ${staff.venueName}.\nCuando tengas un comensal, manda su código (0000-0000).\n` +
        (venues.length > 1 ? "Escribe cambiar unidad para moverte a otro local." : ""),
    );
    return;
  }

  if (intent.intent === "help") {
    await reply(
      admin,
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
      admin,
      twilio,
      staff.phoneE164,
      await replyStaffCoach({
        sessionState: session.state,
        venueName: staff.venueName,
        multiVenue: venues.length > 1,
        userMessage: body,
        situation: "consumer_identified",
        conversationHistory,
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
      admin,
      twilio,
      staff.phoneE164,
      await replyStaffCoach({
        sessionState: "idle",
        venueName: staff.venueName,
        multiVenue: venues.length > 1,
        userMessage: body,
        conversationHistory,
      }),
    );
    return;
  }

  await reply(
    admin,
    twilio,
    staff.phoneE164,
    await replyStaffCoach({
      sessionState: session.state,
      venueName: staff.venueName,
      multiVenue: venues.length > 1,
      userMessage: body,
      conversationHistory,
    }),
  );
}

function prefixActiveVenue(staff: StaffContext): string {
  return `Unidad: ${staff.venueName}\n`;
}

function helpText(
  state: string,
  staff: StaffContext,
  venues: StaffVenue[],
  canSwitch: boolean,
): string {
  const switchLine = canSwitch
    ? "cambiar unidad — otro local (solo sin comensal activo)\n"
    : "";
  switch (state) {
    case "selecting_venue":
      return venuePickerText(venues);
    case "consumer_identified":
      return (
        prefixActiveVenue(staff) +
        "Manda la cuenta, por ejemplo:\n" +
        "• SUBTOTAL 850 PROPINA 100\n" +
        "• o dos números: 850 100 (subtotal y propina)\n" +
        "Montos en pesos. Escribe cancelar para empezar de nuevo."
      );
    case "awaiting_staff_payment_confirm":
      return prefixActiveVenue(staff) +
        "Cuando el comensal haya pagado su parte, responde listo o sí.";
    default:
      return (
        prefixActiveVenue(staff) +
        "Mesita Ops — tickets con descuento\n" +
        "1) Código del comensal (0000-0000)\n" +
        "2) SUBTOTAL y PROPINA\n" +
        "3) El comensal confirma en la app Mesita\n" +
        "4) Tú respondes listo cuando cobres\n" +
        switchLine +
        "cancelar — reinicia la sesión del comensal (mantienes esta unidad)."
      );
  }
}

function venuePickerText(venues: StaffVenue[]): string {
  const lines = venues.map((v, i) => `${i + 1}) ${v.venueName}`);
  return (
    "Trabajas en varios locales de Mesita.\n" +
    "¿En cuál estás hoy? (un WhatsApp = una unidad activa):\n\n" +
    lines.join("\n") +
    "\n\nResponde con el número (ej. 1) o el nombre del lugar.\n" +
    "Después puedes escribir cambiar unidad cuando no tengas un comensal activo."
  );
}

function isSwitchVenueCommand(body: string): boolean {
  return /^(switch|cambiar(\s+unidad)?|unidad|sucursal|venue|unit)\b/i.test(
    body.trim(),
  );
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
      admin,
      twilio,
      staff.phoneE164,
      `No encontré comensal con el código ${displayConsumerCode(code)}. Revísalo e inténtalo de nuevo.`,
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
    admin,
    twilio,
    staff.phoneE164,
    `Comensal verificado ✓\n` +
      `Código: ${displayConsumerCode(code)}\n` +
      `Nombre: ${name}\n` +
      `Nivel: ${tier}${igLine}${subLine}\n` +
      `Saldo Mesita: ${formatMoneyMx(c.cashback_balance_cents ?? 0)}\n\n` +
      `Unidad: ${staff.venueName}\n` +
      `(El descuento aplica solo en este local.)\n\n` +
      `Manda la cuenta, por ejemplo:\n` +
      `SUBTOTAL 850 PROPINA 100`,
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
    await reply(admin, twilio, staff.phoneE164, "No encontré el restaurante.");
    return;
  }
  const venue = venueRes.data as VenueRateRow;
  if (venue.fiscal_type !== "informal") {
    await reply(
      admin,
      twilio,
      staff.phoneE164,
      "Este local usa cashback (formal) — los tickets con descuento no aplican aquí.",
    );
    return;
  }
  if (venue.listing_type !== "partner") {
    await reply(admin, twilio, staff.phoneE164, "El local debe ser partner verificado en Mesita.");
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
    await reply(admin, twilio, staff.phoneE164, "Error con el registro del comensal.");
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
    await reply(admin, twilio, staff.phoneE164, "El total de la cuenta no puede ser cero.");
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
      admin,
      twilio,
      staff.phoneE164,
      `No pude abrir el ticket: ${insert.error.message}`,
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
    admin,
    twilio,
    staff.phoneE164,
    `Cuenta lista ✓ (${staff.venueName})\n` +
      `Subtotal: ${formatMoneyMx(calc.subtotal)}\n` +
      `Propina: ${formatMoneyMx(calc.tip)}\n` +
      `Descuento (${calc.discountPercent}%): -${formatMoneyMx(calc.discountCents)}\n` +
      (calc.redeemCents > 0
        ? `Saldo Mesita: -${formatMoneyMx(calc.redeemCents)}\n`
        : "") +
      `Paga el comensal: ${formatMoneyMx(calc.amountDueCents)}\n\n` +
      `Cobra ${formatMoneyMx(calc.amountDueCents)} (efectivo o terminal).\n` +
      `El comensal confirma en la app. Cuando cobres, responde listo.`,
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
      await reply(admin, twilio, staff.phoneE164, `Error al cerrar: ${done.error}`);
      return;
    }
    await resetSession(admin, session.id, staff.venueId);
    await reply(
      admin,
      twilio,
      staff.phoneE164,
      "Pago registrado ✓ Ticket cerrado. El comensal verá la reseña en la app.",
    );
    return;
  }

  await admin
    .from("staff_whatsapp_sessions")
    .update({ state: "awaiting_staff_payment_confirm" })
    .eq("id", session.id);

  await reply(
    admin,
    twilio,
    staff.phoneE164,
    "Quedó tu confirmación. Esperamos que el comensal confirme en la app Mesita.",
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
        await sendStaffWhatsAppReply(
          admin,
          twilio,
          staffPhone,
          `El comensal confirmó el pago en ${venueRes.data?.name ?? "tu local"} ✓\n` +
            `Responde listo cuando hayas cobrado.`,
        );
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
      await sendStaffWhatsAppReply(
        admin,
        twilio,
        staffPhone,
        `El comensal confirmó en la app (${venueRes.data?.name ?? "local"}).\n` +
          `Responde listo cuando cobres.`,
      );
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

async function reply(
  admin: SupabaseClient,
  twilio: TwilioEnv,
  to: string,
  body: string,
) {
  await sendStaffWhatsAppReply(admin, twilio, to, body);
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
