// Natural-language Staff Ops WhatsApp copy + optional LLM polish.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export type StaffAccessDeniedReason = "unknown_phone" | "not_on_team";

export type StaffCoachContext = {
  sessionState: string;
  venueName: string | null;
  multiVenue: boolean;
  userMessage: string;
  situation?: string;
  conversationHistory?: string;
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
    "No entendí. Manda el código Mesita del comensal (0000-0000) o escribe ayuda.",
  consumer_identified: (ctx) =>
    (ctx.venueName ? `Unidad: ${ctx.venueName}\n` : "") +
    "Listo con el comensal — manda la cuenta, por ejemplo:\nSUBTOTAL 850 PROPINA 100\n(o dos números: 850 100, en pesos).",
  awaiting_staff_payment_confirm: (ctx) =>
    (ctx.venueName ? `Unidad: ${ctx.venueName}\n` : "") +
    "Esperando el pago. Cuando el comensal confirme en la app y cobres, responde listo o sí.",
  awaiting_payment_confirm: (ctx) =>
    (ctx.venueName ? `Unidad: ${ctx.venueName}\n` : "") +
    "Esperando el pago. Cuando el comensal confirme en la app y cobres, responde listo o sí.",
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
  userMessage: string,
  conversationHistory = "",
): Promise<string> {
  const base = staticUnauthReply(reason);
  const historyBlock = conversationHistory.trim()
    ? `Conversación reciente:\n${conversationHistory.trim()}\n\n`
    : "";
  return polishWithLlm({
    system:
      "Eres Mesita Ops por WhatsApp. La persona NO es staff autorizado. " +
      "Reescribe el mensaje BASE: menos de 400 caracteres, cercano y claro, humor ligero ok, " +
      "sin insultos. Español de México si escribieron en español. No inventes pasos que no estén en BASE.",
    user:
      `${historyBlock}BASE:\n${base}\n\nÚltimo mensaje:\n${userMessage.slice(0, 500)}`,
    fallback: base,
  });
}

export async function replyStaffCoach(ctx: StaffCoachContext): Promise<string> {
  const base = staticCoachReply(ctx);
  const historyBlock = ctx.conversationHistory?.trim()
    ? `Conversación reciente:\n${ctx.conversationHistory.trim()}\n\n`
    : "";
  return polishWithLlm({
    system:
      "Eres Mesita Ops, asistente por WhatsApp para meseros con tickets con descuento (tipo A). " +
      "El mensaje no quedó claro. Una respuesta corta (menos de 400 caracteres): amable, directa. " +
      "Di qué deben mandar según SESSION y la conversación. Español de México si aplica. " +
      "No inventes códigos ni montos.",
    user:
      `${historyBlock}SESSION: ${ctx.sessionState}\n` +
      `UNIDAD: ${ctx.venueName ?? "(aún no eligió)"}\n` +
      `VARIAS_UNIDADES: ${ctx.multiVenue}\n` +
      `SITUACIÓN: ${ctx.situation ?? "poco claro"}\n` +
      `PISTA (síguela):\n${base}\n\n` +
      `Último mensaje del mesero:\n${ctx.userMessage.slice(0, 800)}`,
    fallback: base,
  });
}

async function polishWithLlm(opts: {
  system: string;
  user: string;
  fallback: string;
}): Promise<string> {
  const openaiKey = Deno.env.get("OPENAI_KEY")?.trim();
  if (!openaiKey) return opts.fallback;

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 220,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
    });
    if (!r.ok) return opts.fallback;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text || text.length > 500) return opts.fallback;
    return text;
  } catch {
    return opts.fallback;
  }
}
