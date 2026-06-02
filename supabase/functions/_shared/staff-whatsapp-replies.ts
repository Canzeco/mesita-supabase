// Staff Ops WhatsApp copy — deterministic (no LLM rewrite; avoids invented amounts/codes).

import { type BillDraft } from "./staff-bill-draft.ts";

export type StaffAccessDeniedReason = "unknown_phone" | "not_on_team";

export type StaffCoachContext = {
  sessionState: string;
  venueName: string | null;
  multiVenue: boolean;
  userMessage: string;
  situation?: string;
  conversationHistory?: string;
  pendingBill?: BillDraft;
};

const UNAUTH_STATIC: Record<StaffAccessDeniedReason, string> = {
  unknown_phone:
    "Mesita Ops es solo para el equipo del restaurante.\n\n" +
    "Pide a tu manager que te invite con este número y, cuando llegue el mensaje, responde sí.",
  not_on_team:
    "Este número no está en ningún equipo todavía.\n\n" +
    "Pide la invitación a tu manager y responde sí cuando te escribamos.",
};

const COACH_STATIC: Record<string, (ctx: StaffCoachContext) => string> = {
  selecting_venue: (ctx) =>
    ctx.multiVenue
      ? "Primero dime en qué unidad trabajas hoy: responde con el número de la lista (1, 2, …) o el nombre del lugar. Escribe ayuda para ver la lista otra vez."
      : "Primero elige tu unidad y luego manda el código del comensal (0000-0000).",
  idle: (ctx) =>
    (ctx.venueName ? `Unidad: ${ctx.venueName}\n` : "") +
    "Manda el código Mesita del comensal (0000-0000) o escribe ayuda.\n\n" +
    "Flujo: código → subtotal y propina por aquí → el comensal confirma en la app (Pay).",
  consumer_identified: (ctx) => {
    const base = ctx.venueName ? `Unidad: ${ctx.venueName}\n` : "";
    if (ctx.pendingBill?.subtotal_cents != null && ctx.pendingBill.tip_cents == null) {
      return base +
        "Solo falta la propina (ej. PROPINA 100 o 100, o 0).\n" +
        "Cuando esté completo, al comensal le llega la cuenta en la app Mesita → Pay.";
    }
    return base +
      "Manda la cuenta (ej. SUBTOTAL 850, luego PROPINA 100, o 850 y después 100).\n" +
      "Al cerrar la cuenta, el comensal recibe notificación en la app → Pay para confirmar su pago.";
  },
  partial_bill: (ctx) => {
    const base = ctx.venueName ? `Unidad: ${ctx.venueName}\n` : "";
    if (ctx.pendingBill?.subtotal_cents != null && ctx.pendingBill.tip_cents == null) {
      return base +
        "Falta la propina. Después el comensal verá el ticket en la app (Pay).";
    }
    return base +
      "Manda subtotal y propina. El comensal no usa WhatsApp para pagar — confirma en la app (Pay).";
  },
  awaiting_staff_payment_confirm: (ctx) =>
    (ctx.venueName ? `Unidad: ${ctx.venueName}\n` : "") +
    "Esperando al comensal en la app (Pay). Cuando confirme y cobres en caja, responde listo o sí.",
  awaiting_payment_confirm: (ctx) =>
    (ctx.venueName ? `Unidad: ${ctx.venueName}\n` : "") +
    "Esperando al comensal en la app (Pay). Cuando confirme y cobres, responde listo o sí.",
  invalid_venue_pick: () =>
    "Ese número no está en tu lista. Responde con una opción válida (1, 2, …) o el nombre del lugar. Escribe ayuda para ver la lista.",
  default: (ctx) => staticCoachReply(ctx),
};

export function staticUnauthReply(reason: StaffAccessDeniedReason): string {
  return UNAUTH_STATIC[reason];
}

export function staticCoachReply(ctx: StaffCoachContext): string {
  const key = ctx.situation && COACH_STATIC[ctx.situation]
    ? ctx.situation
    : ctx.sessionState in COACH_STATIC
    ? ctx.sessionState
    : "default";
  const fn = COACH_STATIC[key] ?? COACH_STATIC.default;
  return fn(ctx);
}

export async function replyUnauthorizedStaff(
  reason: StaffAccessDeniedReason,
  _userMessage: string,
  _conversationHistory = "",
): Promise<string> {
  return staticUnauthReply(reason);
}

/** Deterministic coach copy — never invent codes or amounts via LLM. */
export async function replyStaffCoach(ctx: StaffCoachContext): Promise<string> {
  return staticCoachReply(ctx);
}
