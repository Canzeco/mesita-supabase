// Staff invite accept — WhatsApp Flow submission (template) or SI reply (fallback).

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  buildStaffInviteAcceptedReply,
  ensureAuthUserForStaffPhone,
  findPendingStaffInviteByToken,
  findPendingStaffInviteForPhone,
  isStaffInviteAcceptMessage,
  phonesMatch,
  redeemStaffInvite,
} from "./staff-invite-redeem.ts";
import { sendWhatsAppText, type TwilioEnv } from "./twilio.ts";

/** Parse flow_token from Twilio InteractiveData / FlowData. */
export function extractStaffInviteFlowToken(
  params: Record<string, string>,
): string | null {
  const raw = params.InteractiveData ?? params.FlowData ?? "";
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const flowResponse = parsed.flowResponse as Record<string, unknown> | undefined;
    const token = (flowResponse?.flow_token ?? parsed.flow_token) as string | undefined;
    if (typeof token === "string" && token.trim()) return token.trim();
  } catch {
    /* FlowData may be flat JSON without flowResponse wrapper */
    try {
      const flat = JSON.parse(raw) as { flow_token?: string };
      if (flat.flow_token?.trim()) return flat.flow_token.trim();
    } catch {
      return null;
    }
  }
  return null;
}

export function isWhatsAppFlowSubmission(params: Record<string, string>): boolean {
  if (params.MessageType === "interactive") return true;
  if (extractStaffInviteFlowToken(params)) return true;
  return !!(params.InteractiveData?.trim() || params.FlowData?.trim());
}

async function completeStaffInviteAccept(opts: {
  admin: SupabaseClient;
  twilio: TwilioEnv;
  fromPhone: string;
  invite: Awaited<ReturnType<typeof findPendingStaffInviteForPhone>>;
}): Promise<{ handled: boolean }> {
  const { admin, twilio, fromPhone, invite } = opts;
  if (!invite) return { handled: false };

  if (invite.phone && !phonesMatch(invite.phone, fromPhone)) {
    await sendWhatsAppText({
      env: twilio,
      from: twilio.whatsappFromStaff,
      to: fromPhone,
      body:
        "Ese invite está ligado a otro número. Pídele a tu manager que reenvíe el invite a este WhatsApp.",
    });
    return { handled: true };
  }

  const userRes = await ensureAuthUserForStaffPhone(admin, fromPhone);
  if (!userRes.ok) {
    await sendWhatsAppText({
      env: twilio,
      from: twilio.whatsappFromStaff,
      to: fromPhone,
      body: "No pude activar tu cuenta. Intenta de nuevo en un momento o avisa a tu manager.",
    });
    return { handled: true };
  }

  const redeemed = await redeemStaffInvite(admin, {
    invite,
    userId: userRes.userId,
  });
  if (!redeemed.ok) {
    const msg =
      redeemed.code === "claimed"
        ? "Ese invite ya fue aceptado."
        : redeemed.code === "expired"
        ? "Ese invite ya expiró. Pide uno nuevo a tu manager."
        : "No pude completar el alta. Intenta de nuevo.";
    await sendWhatsAppText({
      env: twilio,
      from: twilio.whatsappFromStaff,
      to: fromPhone,
      body: msg,
    });
    return { handled: true };
  }

  await sendWhatsAppText({
    env: twilio,
    from: twilio.whatsappFromStaff,
    to: fromPhone,
    body: buildStaffInviteAcceptedReply(redeemed.venueName),
  });
  return { handled: true };
}

/** WhatsApp Flow «Unirme» completed — flow_token = staff_invites.token */
export async function tryAcceptStaffInviteFromFlow(opts: {
  admin: SupabaseClient;
  twilio: TwilioEnv;
  fromPhone: string;
  params: Record<string, string>;
}): Promise<{ handled: boolean }> {
  const token = extractStaffInviteFlowToken(opts.params);
  if (!token) return { handled: false };

  const invite = await findPendingStaffInviteByToken(opts.admin, token);
  if (!invite) {
    await sendWhatsAppText({
      env: opts.twilio,
      from: opts.twilio.whatsappFromStaff,
      to: opts.fromPhone,
      body: "No encontré una invitación activa con ese enlace. Pide a tu manager que te reenvíe el invite.",
    });
    return { handled: true };
  }

  return completeStaffInviteAccept({
    admin: opts.admin,
    twilio: opts.twilio,
    fromPhone: opts.fromPhone,
    invite,
  });
}

export async function promptPendingStaffInviteOnWhatsApp(opts: {
  admin: SupabaseClient;
  twilio: TwilioEnv;
  fromPhone: string;
  body: string;
}): Promise<{ handled: boolean }> {
  const { admin, twilio, fromPhone, body } = opts;
  if (isStaffInviteAcceptMessage(body)) return { handled: false };
  const invite = await findPendingStaffInviteForPhone(admin, fromPhone);
  if (!invite) return { handled: false };

  await sendWhatsAppText({
    env: twilio,
    from: twilio.whatsappFromStaff,
    to: fromPhone,
    body:
      `Tienes una invitación pendiente de ${invite.venue_name}.\n\n` +
      `Abre el mensaje de invitación y toca «Unirme», o responde SI aquí.`,
  });
  return { handled: true };
}

export async function tryAcceptStaffInviteOnWhatsApp(opts: {
  admin: SupabaseClient;
  twilio: TwilioEnv;
  fromPhone: string;
  body: string;
}): Promise<{ handled: boolean }> {
  const { admin, twilio, fromPhone, body } = opts;
  if (!isStaffInviteAcceptMessage(body)) return { handled: false };

  const invite = await findPendingStaffInviteForPhone(admin, fromPhone);
  return completeStaffInviteAccept({
    admin,
    twilio,
    fromPhone,
    invite,
  });
}
