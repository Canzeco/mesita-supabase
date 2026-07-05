// Staff WhatsApp orchestration — Ticket Type A (dp, informal, no story).
//
// Business rule: one WhatsApp number → exactly one active place at a time.
// Staff may belong to many units; they must pick (or SWITCH) before guest codes.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  applyActivePlace,
  enterPlaceSelection,
  helpText,
  idleOpsBlockedReminder,
  isSwitchPlaceCommand,
  loadSession,
  parsePlaceSelection,
  resetSession,
  resolveActivePlace,
  placePickerText,
} from "./staff-whatsapp-session.ts";
import { resolveTicketOpener } from "./staff-whatsapp-payment.ts";
import type {
  SessionRow,
  StaffContext,
  StaffIdentity,
  StaffPlace,
} from "./staff-whatsapp-types.ts";
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
  loadPlaceOpsRow,
  placeOpsShortWarning,
} from "./staff-place-ops.ts";
import { placeHasVerifiedOwner } from "./place-ownership.ts";
import { replyStaffCoach } from "./staff-whatsapp-replies.ts";
import {
  buildConsumerBillPayload,
  closeTicketAndEnqueueReview,
  computeInformalBill,
  formatMoneyMx,
  type ConsumerRow,
} from "./ticket-informal.ts";
import { sendStaffWhatsAppReply } from "./staff-whatsapp-messages.ts";
import { sendWhatsAppText, type TwilioEnv } from "./twilio.ts";

export type { StaffAccess, StaffIdentity, StaffPlace } from "./staff-whatsapp-types.ts";
export { resolveStaffAccess } from "./staff-whatsapp-access.ts";

export async function handleStaffInboundMessage(opts: {
  admin: SupabaseClient;
  twilio: TwilioEnv;
  identity: StaffIdentity;
  body: string;
  conversationHistory?: string;
}): Promise<void> {
  const { admin, twilio, identity, body, conversationHistory = "" } = opts;
  const places = identity.places;

  let session = await loadSession(admin, identity.phoneE164);

  if (isSwitchPlaceCommand(body)) {
    if (session && session.state !== "idle" && session.state !== "selecting_project") {
      await reply(
        admin,
        twilio,
        identity.phoneE164,
        "Termina o escribe cancelar la sesión del comensal antes de cambiar de unidad.",
      );
      return;
    }
    if (places.length < 2) {
      await reply(
        admin,
        twilio,
        identity.phoneE164,
        places.length === 1
          ? `Solo estás en el equipo de ${places[0].placeName}. No hace falta cambiar.`
          : "No tienes un restaurante asignado en tu perfil.",
      );
      return;
    }
    session = await enterPlaceSelection(admin, identity, session, places);
    await reply(admin, twilio, identity.phoneE164, placePickerText(places));
    return;
  }

  const sessionState = session?.state ?? "selecting_project";
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
    (session?.state === "selecting_project" || !session?.project_id) &&
    places.length > 1
  ) {
    await reply(admin, twilio, identity.phoneE164, placePickerText(places));
    return;
  }

  if (intent.intent === "select_project" && intent.place_index != null) {
    const picked = places[intent.place_index];
    if (picked) {
      session = await applyActivePlace(admin, identity, session, picked);
      const warn = await placeOpsShortWarning(admin, picked.projectId);
      await reply(
        admin,
        twilio,
        identity.phoneE164,
        `Unidad activa: ${picked.placeName} ✓\nManda el código Mesita del comensal (0000-0000).` +
          warn,
      );
      return;
    }
    await reply(
      admin,
      twilio,
      identity.phoneE164,
      await replyStaffCoach({
        sessionState: "selecting_project",
        placeName: null,
        multiPlace: places.length > 1,
        userMessage: body,
        situation: "invalid_place_pick",
        conversationHistory,
      }),
    );
    return;
  }

  const placePick = parsePlaceSelection(body, places);
  if (
    placePick &&
    (session?.state === "selecting_project" || !session?.project_id)
  ) {
    const picked = places.find((v) => v.projectId === placePick)!;
    session = await applyActivePlace(admin, identity, session, picked);
    const warn = await placeOpsShortWarning(admin, picked.projectId);
    await reply(
      admin,
      twilio,
      identity.phoneE164,
      `Unidad activa: ${picked.placeName} ✓\nManda el código Mesita del comensal (0000-0000).` +
        warn,
    );
    return;
  }

  const resolved = await resolveActivePlace(admin, identity, session);
  if (resolved.kind === "need_selection") {
    session = resolved.session;
    const unclear =
      intent.intent === "unknown" &&
      !parsePlaceSelection(body, places) &&
      intent.place_index == null;
    if (unclear && body.trim().length > 0) {
      await reply(
        admin,
        twilio,
        identity.phoneE164,
        await replyStaffCoach({
          sessionState: "selecting_project",
          placeName: null,
          multiPlace: places.length > 1,
          userMessage: body,
          conversationHistory,
        }),
      );
    } else {
      await reply(admin, twilio, identity.phoneE164, placePickerText(places));
    }
    return;
  }

  const staff = resolved.staff;
  session = resolved.session;

  if (intent.intent === "cancel") {
    await resetSession(admin, session.id, staff.projectId);
    await reply(
      admin,
      twilio,
      staff.phoneE164,
      `Sesión reiniciada en ${staff.placeName}.\nCuando tengas un comensal, manda su código (0000-0000).\n` +
        (places.length > 1 ? "Escribe cambiar unidad para moverte a otro local." : ""),
    );
    return;
  }

  if (intent.intent === "help") {
    await reply(
      admin,
      twilio,
      staff.phoneE164,
      helpText(session.state, staff, places, places.length > 1),
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
        placeName: staff.placeName,
        multiPlace: places.length > 1,
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
    session.state === "awaiting_staff_payment_confirm" &&
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
        placeName: staff.placeName,
        multiPlace: places.length > 1,
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
      placeName: staff.placeName,
      multiPlace: places.length > 1,
      userMessage: body,
      conversationHistory,
      pendingBill,
      situation: coachSituation,
    }),
  );
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
      "id, code, full_name, first_name, last_name, class_key, class_origin, consumer_instagram_followers_count, phone",
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
  const placeRow = await loadPlaceOpsRow(admin, staff.projectId);
  if (!placeRow) {
    await reply(admin, twilio, staff.phoneE164, "No encontré el restaurante.");
    return null;
  }
  const placeOps = await guestRewardContext(
    admin,
    placeRow,
    c.id,
    c.class_key,
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
  const tier = c.class_key ?? "free";
  const ig = c.consumer_instagram_followers_count;
  const igLine = ig != null ? `\nInstagram followers: ${ig}` : "";
  const subLine = subRes.data
    ? `\nSubscription: active`
    : `\nSubscription: none (${c.class_origin ?? "default"})`;

  const guestBlock =
    `Comensal verificado ✓\n` +
    `Código: ${displayConsumerCode(code)}\n` +
    `Nombre: ${name}\n` +
    `Nivel: ${tier}${igLine}${subLine}\n` +
    `Unidad: ${staff.placeName}\n` +
    `${placeOps.rewardLine}\n`;

  if (!placeOps.ops.ok) {
    await admin
      .from("staff_whatsapp_sessions")
      .update({
        state: "idle",
        consumer_id: null,
        pending_consumer_code: code,
        ticket_id: null,
        context: {
          consumer_preview: { name, tier },
          ops_block: placeOps.ops,
        },
      })
      .eq("id", session.id);

    await reply(
      admin,
      twilio,
      staff.phoneE164,
      guestBlock +
        `\n⚠️ No puedes abrir ticket con descuento aquí:\n${placeOps.ops.staffMessage}`,
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
  const place = await loadPlaceOpsRow(admin, staff.projectId);
  if (!place) return false;
  const hasOwner = await placeHasVerifiedOwner(admin, staff.projectId);
  const ops = assessDiscountTicketOps(place, hasOwner);
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
    `Unidad: ${staff.placeName}\n\n⚠️ ${ops.staffMessage}`,
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
      tip: 0,
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

  const place = await loadPlaceOpsRow(admin, staff.projectId);
  if (!place) {
    await reply(admin, twilio, staff.phoneE164, "No encontré el restaurante.");
    return;
  }
  const hasOwner = await placeHasVerifiedOwner(admin, staff.projectId);
  const ops = assessDiscountTicketOps(place, hasOwner);
  if (!ops.ok) {
    await reply(
      admin,
      twilio,
      staff.phoneE164,
      `Unidad: ${staff.placeName}\n\n⚠️ ${ops.staffMessage}`,
    );
    await resetSession(admin, session.id, staff.projectId);
    return;
  }
  if (place.status === "archived") {
    await reply(admin, twilio, staff.phoneE164, "Este local está archivado.");
    return;
  }

  const consumerRes = await admin
    .from("consumers")
    .select(
      "id, code, full_name, first_name, last_name, class_key, class_origin, consumer_instagram_followers_count, phone",
    )
    .eq("id", session.consumer_id)
    .single();
  if (consumerRes.error) {
    await reply(admin, twilio, staff.phoneE164, "Error con el registro del comensal.");
    return;
  }

  const calc = await computeInformalBill(
    admin,
    place,
    consumerRes.data as ConsumerRow,
    amounts.subtotal,
    amounts.tip,
  );

  if (calc.subtotal === 0) {
    await reply(admin, twilio, staff.phoneE164, "El total de la cuenta no puede ser cero.");
    return;
  }

  const opener = await resolveTicketOpener(admin, staff.projectId, staff.staffUserId);

  const now = new Date().toISOString();
  const insert = await admin
    .from("tickets")
    .insert({
      project_id: staff.projectId,
      consumer_id: session.consumer_id,
      opened_by: opener,
      opened_by_staff_user_id: staff.staffUserId,
      // Staff WhatsApp Type-A flow is discount-only (no story, no reservation),
      // which persists as `coupon` under the collapsed ticket_kind enum.
      kind: "coupon",
      status: "awaiting_payment_confirm",
      story_status: "not_required",
      check_subtotal_cents: calc.subtotal,
      tip_cents: calc.tip,
      total_cents: calc.total,
      redeem_cents: 0,
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
  const payload = buildConsumerBillPayload(place, calc, staff.projectId);

  // Deliver the discounted bill receipt to the consumer's Pay inbox.
  await admin.from("consumer_pay_notifications").insert({
    consumer_id: session.consumer_id,
    ticket_id: ticketId,
    kind: "bill",
    status: "completed",
    resolved_at: now,
    payload,
  });

  // Hold the ticket at the staff payment-confirm gate until the waiter replies
  // "listo" once they've collected payment.
  await admin
    .from("staff_whatsapp_sessions")
    .update({ state: "awaiting_staff_payment_confirm", ticket_id: ticketId })
    .eq("id", session.id);

  const guestPhone = consumerRes.data.phone;
  if (guestPhone) {
    await sendWhatsAppText({
      env: twilio,
      from: twilio.whatsappFromConsumers,
      to: guestPhone,
      body:
        `Mesita — ${place.name}\n` +
        `Bill: ${formatMoneyMx(calc.total)}\n` +
        `Discount (${calc.discountPercent}%): -${formatMoneyMx(calc.discountCents)}\n` +
        `You pay: ${formatMoneyMx(calc.amountDueCents)}\n\n` +
        `Pay at the table — the staff will close it out.`,
    });
  }

  await reply(
    admin,
    twilio,
    staff.phoneE164,
    `Cuenta lista ✓ (${staff.placeName})\n` +
      `Subtotal: ${formatMoneyMx(calc.subtotal)}\n` +
      `Descuento (${calc.discountPercent}%): -${formatMoneyMx(calc.discountCents)}\n` +
      `Cobra al comensal: ${formatMoneyMx(calc.amountDueCents)} (efectivo o terminal).\n\n` +
      `Cuando cobres, responde *listo* para cerrar el ticket.`,
  );
}

async function handleStaffPaymentConfirm(
  admin: SupabaseClient,
  twilio: TwilioEnv,
  staff: StaffContext,
  session: SessionRow,
) {
  if (!session.ticket_id || !session.consumer_id) return;

  const ticket = await admin
    .from("tickets")
    .select("id, status")
    .eq("id", session.ticket_id)
    .maybeSingle();
  if (!ticket.data || ticket.data.status !== "awaiting_payment_confirm") {
    await resetSession(admin, session.id, staff.projectId);
    await reply(
      admin,
      twilio,
      staff.phoneE164,
      "No hay un cobro pendiente. Manda el código del siguiente comensal.",
    );
    return;
  }

  const done = await closeTicketAndEnqueueReview(
    admin,
    session.ticket_id,
    session.consumer_id,
    staff.projectId,
  );
  if (!done.ok) {
    await reply(admin, twilio, staff.phoneE164, `Error al cerrar: ${done.error}`);
    return;
  }

  await resetSession(admin, session.id, staff.projectId);
  await reply(
    admin,
    twilio,
    staff.phoneE164,
    `Pago registrado ✓ Ticket cerrado en ${staff.placeName}.\n` +
      `El comensal ya puede dejar su reseña en la app.\n` +
      `Manda el código del siguiente comensal cuando quieras.`,
  );
}

async function reply(
  admin: SupabaseClient,
  twilio: TwilioEnv,
  to: string,
  body: string,
) {
  await sendStaffWhatsAppReply(admin, twilio, to, body);
}
