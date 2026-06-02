// Accept waiter invites inside Mesita Ops WhatsApp (reply SI / YES — no links).

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  buildStaffInviteAcceptedReply,
  ensureAuthUserForStaffPhone,
  findPendingStaffInviteForPhone,
  isStaffInviteAcceptMessage,
  phonesMatch,
  redeemStaffInvite,
} from "./staff-invite-redeem.ts";
import { sendWhatsAppText, type TwilioEnv } from "./twilio.ts";

/** Remind invitee to reply SI (no web). */
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
      `Responde SI en este chat para unirte al equipo (sin links).`,
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
