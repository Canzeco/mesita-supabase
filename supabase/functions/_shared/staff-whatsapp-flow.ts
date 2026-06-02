// Staff WhatsApp orchestration — Ticket Type A (dp, informal, no story).
//
// Business rule: one WhatsApp number → exactly one active venue at a time.
// Staff may belong to many units; they must pick (or SWITCH) before guest codes.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  displayConsumerCode,
  extractConsumerCodeFromText,
} from "./consumer-code.ts";
import {
  billDraftFromContext,
  billDraftHasAnyAmount,
  billDraftNeedMessage,
  billDraftToContext,
  buildIncomingBill,
  isBillDraftReady,
  messageLooksLikeBill,
  parseBillParts,
} from "./staff-bill-draft.ts";
import { isCasualStaffMessage, parseStaffWhatsAppMessage } from "./staff-llm.ts";
import {
  assessDiscountTicketOps,
  guestRewardContext,
  loadVenueOpsRow,
  venueOpsShortWarning,
} from "./staff-venue-ops.ts";
import { venueHasVerifiedOwner } from "./venue-ownership.ts";
import { replyStaffCoach } from "./staff-whatsapp-replies.ts";
import {
  buildConsumerBillPayload,
  computeInformalBill,
  finalizeInformalTicket,
  formatMoneyMx,
  type ConsumerRow,
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
  const pendingBill = billDraftFromContext(session?.context ?? {});
  const codeInBody = extractConsumerCodeFromText(body);
  const intent = await parseStaffWhatsAppMessage(
    body,
    sessionState,
    conversationHistory,
    pendingBill,
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
      const warn = await venueOpsShortWarning(admin, picked.venueId);
      await reply(
        admin,
        twilio,
        identity.phoneE164,
        `Unidad activa: ${picked.venueName} ✓\nManda el código Mesita del comensal (0000-0000).` +
          warn,
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
    const warn = await venueOpsShortWarning(admin, picked.venueId);
    await reply(
      admin,
      twilio,
      identity.phoneE164,
      `Unidad activa: ${picked.venueName} ✓\nManda el código Mesita del comensal (0000-0000).` +
        warn,
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

  if (
    session.state === "idle" &&
    isCasualStaffMessage(body) &&
    !codeInBody
  ) {
    const opsBlock = session.context?.ops_block as
      | { staffMessage?: string }
      | undefined;
    if (opsBlock?.staffMessage && session.pending_consumer_code) {
      await reply(
        admin,
        twilio,
        staff.phoneE164,
        idleOpsBlockedReminder(staff, session, opsBlock.staffMessage),
      );
      return;
    }
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

  if (intent.intent === "lookup_code" && intent.consumer_code && codeInBody) {
    const sameGuest = intent.consumer_code === session.pending_consumer_code;
    if (
      session.state === "consumer_identified" &&
      sameGuest &&
      !messageLooksLikeBill(body) &&
      intent.check_subtotal_cents == null &&
      intent.tip_cents == null
    ) {
      await reply(
        admin,
        twilio,
        staff.phoneE164,
        `Ya tienes activo el código ${displayConsumerCode(intent.consumer_code)}.\n` +
          billDraftNeedMessage(pendingBill),
      );
      return;
    }
    const updated = await handleLookupCode(
      admin,
      twilio,
      staff,
      session,
      intent.consumer_code,
      { skipBillHint: messageLooksLikeBill(body) },
    );
    if (updated) {
      session = updated;
      if (
        await tryHandleBillDraft({
          admin,
          twilio,
          staff,
          session,
          body,
          intent,
        })
      ) {
        return;
      }
    }
    return;
  }

  if (
    await tryHandleBillDraft({
      admin,
      twilio,
      staff,
      session,
      body,
      intent,
    })
  ) {
    return;
  }

  if (
    session.state === "consumer_identified" &&
    (messageLooksLikeBill(body) || billDraftHasAnyAmount(pendingBill))
  ) {
    const blocked = await replyIfDiscountOpsBlocked(
      admin,
      twilio,
      staff,
      session,
    );
    if (blocked) return;
  }

  if (
    intent.intent === "confirm_payment" &&
    session.ticket_id &&
    (intent.confirm === true || intent.confirm === null)
  ) {
    await handleStaffPaymentConfirm(admin, twilio, staff, session);
    return;
  }

  if (intent.consumer_code && session.state === "idle" && codeInBody) {
    const updated = await handleLookupCode(
      admin,
      twilio,
      staff,
      session,
      intent.consumer_code,
      { skipBillHint: messageLooksLikeBill(body) },
    );
    if (updated) {
      session = updated;
      if (
        await tryHandleBillDraft({
          admin,
          twilio,
          staff,
          session,
          body,
          intent,
        })
      ) {
        return;
      }
    }
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
        pendingBill,
      }),
    );
    return;
  }

  const coachSituation = billDraftHasAnyAmount(pendingBill)
    ? "partial_bill"
    : undefined;

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
      pendingBill,
      situation: coachSituation,
    }),
  );
}

function prefixActiveVenue(staff: StaffContext): string {
  return `Unidad: ${staff.venueName}\n`;
}

function idleOpsBlockedReminder(
  staff: StaffContext,
  session: SessionRow,
  opsMessage: string,
): string {
  const code = session.pending_consumer_code
    ? displayConsumerCode(session.pending_consumer_code)
    : null;
  const preview = session.context?.consumer_preview as
    | { name?: string }
    | undefined;
  const name = preview?.name;
  let msg = `Unidad: ${staff.venueName}\n`;
  if (code && name) msg += `Último comensal: ${name} (${code})\n`;
  msg +=
    `\nNo puedes abrir ticket con descuento todavía:\n${opsMessage}\n\n` +
    `Manda otro código cuando esté listo, o escribe ayuda.`;
  return msg;
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
        "Manda la cuenta en un mensaje o en varios:\n" +
        "• SUBTOTAL 850 y después PROPINA 100\n" +
        "• o 850 y luego 100\n" +
        "Montos en pesos. Escribe cancelar para empezar de nuevo."
      );
    case "awaiting_staff_payment_confirm":
      return prefixActiveVenue(staff) +
        "Cuando el comensal haya pagado su parte, responde listo o sí.";
    default:
      return (
        prefixActiveVenue(staff) +
        "Mesita Ops — ticket con descuento (tipo A)\n" +
        "1) Código del comensal (0000-0000)\n" +
        "2) SUBTOTAL y PROPINA por WhatsApp\n" +
        "3) El comensal recibe la cuenta en la app → Pay y confirma ahí\n" +
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
  opts?: { skipBillHint?: boolean },
): Promise<SessionRow | null> {
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
    return null;
  }
  const c = consumerRes.data as ConsumerRow;
  const venueRow = await loadVenueOpsRow(admin, staff.venueId);
  if (!venueRow) {
    await reply(admin, twilio, staff.phoneE164, "No encontré el restaurante.");
    return null;
  }
  const venueOps = await guestRewardContext(
    admin,
    venueRow,
    c.id,
    c.tier_key,
  );

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

  const guestBlock =
    `Comensal verificado ✓\n` +
    `Código: ${displayConsumerCode(code)}\n` +
    `Nombre: ${name}\n` +
    `Nivel: ${tier}${igLine}${subLine}\n` +
    `Saldo Mesita: ${formatMoneyMx(c.cashback_balance_cents ?? 0)}\n\n` +
    `Unidad: ${staff.venueName}\n` +
    `${venueOps.rewardLine}\n`;

  if (!venueOps.ops.ok) {
    await admin
      .from("staff_whatsapp_sessions")
      .update({
        state: "idle",
        consumer_id: null,
        pending_consumer_code: code,
        ticket_id: null,
        context: {
          consumer_preview: { name, tier },
          ops_block: venueOps.ops,
        },
      })
      .eq("id", session.id);

    await reply(
      admin,
      twilio,
      staff.phoneE164,
      guestBlock +
        `\n⚠️ No puedes abrir ticket con descuento aquí:\n${venueOps.ops.staffMessage}`,
    );
    return null;
  }

  const updated = await admin
    .from("staff_whatsapp_sessions")
    .update({
      state: "consumer_identified",
      consumer_id: c.id,
      pending_consumer_code: code,
      ticket_id: null,
      context: {
        consumer_preview: { name, tier },
        pending_bill: {},
        ops_ok: true,
      },
    })
    .eq("id", session.id)
    .select("*")
    .single();
  if (updated.error) {
    await reply(admin, twilio, staff.phoneE164, "Error al guardar la sesión.");
    return null;
  }

  const billHint = opts?.skipBillHint
    ? ""
    : `\n\nManda la cuenta aquí (ej. SUBTOTAL 850, luego PROPINA 100).\n` +
      `Al terminar, el comensal recibe la notificación en la app Mesita → Pay.`;

  await reply(
    admin,
    twilio,
    staff.phoneE164,
    guestBlock +
      `(El descuento aplica solo en este local.)` +
      billHint,
  );

  return updated.data as SessionRow;
}

async function replyIfDiscountOpsBlocked(
  admin: SupabaseClient,
  twilio: TwilioEnv,
  staff: StaffContext,
  session: SessionRow,
): Promise<boolean> {
  const venue = await loadVenueOpsRow(admin, staff.venueId);
  if (!venue) return false;
  const hasOwner = await venueHasVerifiedOwner(admin, staff.venueId);
  const ops = assessDiscountTicketOps(venue, hasOwner);
  if (ops.ok) return false;

  await admin
    .from("staff_whatsapp_sessions")
    .update({
      state: "idle",
      consumer_id: null,
      ticket_id: null,
      pending_consumer_code: session.pending_consumer_code,
      context: { ...session.context, ops_block: ops, pending_bill: {} },
    })
    .eq("id", session.id);

  await reply(
    admin,
    twilio,
    staff.phoneE164,
    `Unidad: ${staff.venueName}\n\n⚠️ ${ops.staffMessage}`,
  );
  return true;
}

async function tryHandleBillDraft(opts: {
  admin: SupabaseClient;
  twilio: TwilioEnv;
  staff: StaffContext;
  session: SessionRow;
  body: string;
  intent: Awaited<ReturnType<typeof parseStaffWhatsAppMessage>>;
}): Promise<boolean> {
  const { admin, twilio, staff, session, body, intent } = opts;
  if (session.state !== "consumer_identified" || !session.consumer_id) {
    return false;
  }

  if (await replyIfDiscountOpsBlocked(admin, twilio, staff, session)) {
    return true;
  }

  const parts = parseBillParts(body);
  const draft = billDraftFromContext(session.context);
  const merged = buildIncomingBill(body, parts, intent, draft);

  const gotNewAmounts = billDraftHasAnyAmount(parts) ||
    intent.check_subtotal_cents != null ||
    intent.tip_cents != null;

  if (!gotNewAmounts && !billDraftHasAnyAmount(draft)) {
    if (intent.intent === "submit_bill") {
      await reply(
        admin,
        twilio,
        staff.phoneE164,
        billDraftNeedMessage(merged),
      );
      return true;
    }
    return false;
  }

  const nextContext = {
    ...session.context,
    pending_bill: billDraftToContext(merged),
  };
  await admin
    .from("staff_whatsapp_sessions")
    .update({ context: nextContext })
    .eq("id", session.id);

  const sessionWithDraft = { ...session, context: nextContext };

  if (isBillDraftReady(merged)) {
    await handleSubmitBill(admin, twilio, staff, sessionWithDraft, {
      subtotal: merged.subtotal_cents!,
      tip: merged.tip_cents!,
    });
    return true;
  }

  await reply(admin, twilio, staff.phoneE164, billDraftNeedMessage(merged));
  return true;
}

async function handleSubmitBill(
  admin: SupabaseClient,
  twilio: TwilioEnv,
  staff: StaffContext,
  session: SessionRow,
  amounts: { subtotal: number; tip: number },
) {
  if (!session.consumer_id) return;

  const venue = await loadVenueOpsRow(admin, staff.venueId);
  if (!venue) {
    await reply(admin, twilio, staff.phoneE164, "No encontré el restaurante.");
    return;
  }
  const hasOwner = await venueHasVerifiedOwner(admin, staff.venueId);
  const ops = assessDiscountTicketOps(venue, hasOwner);
  if (!ops.ok) {
    await reply(
      admin,
      twilio,
      staff.phoneE164,
      `Unidad: ${staff.venueName}\n\n⚠️ ${ops.staffMessage}`,
    );
    await resetSession(admin, session.id, staff.venueId);
    return;
  }
  if (venue.status === "archived") {
    await reply(admin, twilio, staff.phoneE164, "Este local está archivado.");
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
  const payload = buildConsumerBillPayload(venue, calc, staff.venueId);

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
      `Le enviamos notificación en la app Mesita → Pay para que confirme.\n` +
      `Cobra ${formatMoneyMx(calc.amountDueCents)} (efectivo o terminal).\n` +
      `Cuando cobres, responde listo.`,
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
  const [venueRes, ticketRes] = await Promise.all([
    admin.from("venues").select("name, slug, photos").eq("id", venueId).single(),
    admin
      .from("tickets")
      .select(
        "discount_cents, redeem_cents, discount_percent, total_cents, check_subtotal_cents, tip_cents",
      )
      .eq("id", ticketId)
      .single(),
  ]);
  const v = venueRes.data;
  const t = ticketRes.data;
  const discount = t?.discount_cents ?? 0;
  const redeem = t?.redeem_cents ?? 0;
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
      discount_cents: discount,
      discount_percent: t?.discount_percent ?? null,
      redeem_cents: redeem,
      total_reward_cents: discount + redeem,
      total_cents: t?.total_cents ?? null,
      currency: "MXN",
    },
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
