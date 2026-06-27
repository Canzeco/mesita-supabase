// Staff Ops WhatsApp copy — deterministic (no LLM rewrite; avoids invented amounts/codes).

import { type BillDraft } from "./staff-bill-draft.ts";

export type StaffAccessDeniedReason = "unknown_phone" | "not_on_team";

export type StaffCoachContext = {
  sessionState: string;
  placeName: string | null;
  multiPlace: boolean;
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
  selecting_project: (ctx) =>
    ctx.multiPlace
      ? "Primero dime en qué unidad trabajas hoy: responde con el número de la lista (1, 2, …) o el nombre del lugar. Escribe ayuda para ver la lista otra vez."
      : "Primero elige tu unidad y luego manda el código del comensal (0000-0000).",
  idle: (ctx) =>
    (ctx.placeName ? `Unidad: ${ctx.placeName}\n` : "") +
    "Manda el código Mesita del comensal (0000-0000) o escribe ayuda.\n\n" +
    "Flujo: código → subtotal por aquí → el comensal confirma en la app (Pay).",
  consumer_identified: (ctx) => {
    const base = ctx.placeName ? `Unidad: ${ctx.placeName}\n` : "";
    return base +
      "Manda el subtotal de la cuenta (ej. SUBTOTAL 850 o solo 850).\n" +
      "El descuento Mesita aplica al subtotal — sin propina.\n" +
      "Al cerrar, el comensal recibe la cuenta en la app → Pay.";
  },
  partial_bill: (ctx) => {
    const base = ctx.placeName ? `Unidad: ${ctx.placeName}\n` : "";
    return base +
      "Manda el subtotal. El comensal verá el ticket en la app (Pay).";
  },
  awaiting_staff_payment_confirm: (ctx) =>
    (ctx.placeName ? `Unidad: ${ctx.placeName}\n` : "") +
    "Esperando al comensal en la app (Pay). Cuando confirme y cobres en caja, responde listo o sí.",
  awaiting_payment_confirm: (ctx) =>
    (ctx.placeName ? `Unidad: ${ctx.placeName}\n` : "") +
    "Esperando al comensal en la app (Pay). Cuando confirme y cobres, responde listo o sí.",
  invalid_place_pick: () =>
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
