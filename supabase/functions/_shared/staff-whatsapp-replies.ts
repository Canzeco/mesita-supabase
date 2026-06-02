// Human-friendly Staff Ops WhatsApp copy + optional LLM polish.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export type StaffAccessDeniedReason = "unknown_phone" | "not_on_team";

export type StaffCoachContext = {
  sessionState: string;
  venueName: string | null;
  multiVenue: boolean;
  userMessage: string;
  /** Short hint for the model, e.g. invalid_venue_pick */
  situation?: string;
};

const UNAUTH_STATIC: Record<StaffAccessDeniedReason, string> = {
  unknown_phone:
    "Mesita Ops es solo para staff del restaurante.\n\n" +
    "Pide a tu manager que te invite con este número y responde SI al mensaje.",
  not_on_team:
    "Este número no está en ningún equipo.\n\n" +
    "Pide la invitación a tu manager y responde SI aquí.",
};

const COACH_STATIC: Record<string, (ctx: StaffCoachContext) => string> = {
  selecting_venue: (ctx) =>
    ctx.multiVenue
      ? "Pick your unit first — reply with the number from the list (1, 2, …) or the venue name. Type HELP to see the list again."
      : "Pick your unit first, then send the guest's 8-digit code.",
  idle: (ctx) =>
    (ctx.venueName ? `Unit: ${ctx.venueName}\n` : "") +
    "I'm not sure what you mean. Send the guest's Mesita code (0000-0000), or type HELP for steps.",
  consumer_identified: (ctx) =>
    (ctx.venueName ? `Unit: ${ctx.venueName}\n` : "") +
    "Guest is loaded — send the bill like:\nSUBTOTAL 850 TIP 100\n(or two numbers: 850 100, in pesos).",
  awaiting_staff_payment_confirm: (ctx) =>
    (ctx.venueName ? `Unit: ${ctx.venueName}\n` : "") +
    "Waiting on payment. When the guest confirms in the app and you've collected money, reply CONFIRM or YES.",
  awaiting_payment_confirm: (ctx) =>
    (ctx.venueName ? `Unit: ${ctx.venueName}\n` : "") +
    "Waiting on payment. When the guest confirms in the app and you've collected money, reply CONFIRM or YES.",
  invalid_venue_pick: () =>
    "That number isn't on your list. Reply with a valid option (1, 2, …) or type the venue name. HELP shows the list.",
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

/** Witty but professional reply when the sender isn't authorized staff. */
export async function replyUnauthorizedStaff(
  reason: StaffAccessDeniedReason,
  userMessage: string,
): Promise<string> {
  const base = staticUnauthReply(reason);
  return polishWithLlm({
    system:
      "You are Mesita Ops on WhatsApp. The sender is NOT authorized staff. " +
      "Rewrite the BASE message: keep it under 400 chars, friendly and direct, light humor OK, " +
      "never insulting or calling them names. Match Spanish if they wrote in Spanish. " +
      "Do not invent steps they already have in BASE.",
    user: `BASE:\n${base}\n\nThey wrote:\n${userMessage.slice(0, 500)}`,
    fallback: base,
  });
}

/** Guide authenticated staff when we didn't understand the message. */
export async function replyStaffCoach(ctx: StaffCoachContext): Promise<string> {
  const base = staticCoachReply(ctx);
  return polishWithLlm({
    system:
      "You are Mesita Ops, WhatsApp assistant for waitstaff running discount tickets (Type A). " +
      "The message was unclear or off-topic. Write ONE short reply (under 400 chars): friendly, direct, " +
      "no insults. Tell them exactly what to send next based on SESSION. Match their language (ES/EN). " +
      "Never make up guest codes or amounts.",
    user:
      `SESSION: ${ctx.sessionState}\n` +
      `UNIT: ${ctx.venueName ?? "(not selected yet)"}\n` +
      `MULTI_UNIT: ${ctx.multiVenue}\n` +
      `SITUATION: ${ctx.situation ?? "unclear"}\n` +
      `HINT (follow this):\n${base}\n\n` +
      `Staff wrote:\n${ctx.userMessage.slice(0, 800)}`,
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
