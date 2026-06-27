// Staff invite accept — natural-language sí/yes, or Flow submit when we add flows later.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { phonesMatch } from "./phone.ts";
import {
  buildStaffInviteAcceptedReply,
  ensureAuthUserForStaffPhone,
  findPendingStaffInviteByToken,
  findPendingStaffInviteForPhone,
  isStaffInviteAcceptMessage,
  redeemStaffInvite,
} from "./staff-invite-redeem.ts";
import { sendStaffWhatsAppReply } from "./staff-whatsapp-messages.ts";
import type { TwilioEnv } from "./twilio.ts";

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
    await sendStaffWhatsAppReply(
      admin,
      twilio,
      fromPhone,
      "Esa invitación es para otro número. Pídele a tu manager que te la reenvíe a este WhatsApp.",
    );
    return { handled: true };
  }

  const userRes = await ensureAuthUserForStaffPhone(admin, fromPhone);
  if (!userRes.ok) {
    await sendStaffWhatsAppReply(
      admin,
      twilio,
      fromPhone,
      "No pude activar tu cuenta. Intenta de nuevo en un momento o avisa a tu manager.",
    );
    return { handled: true };
  }

  const redeemed = await redeemStaffInvite(admin, {
    invite,
    userId: userRes.userId,
  });
  if (!redeemed.ok) {
    const msg =
      redeemed.code === "claimed"
        ? "Esa invitación ya se usó."
        : redeemed.code === "expired"
        ? "Esa invitación ya venció. Pide una nueva a tu manager."
        : "No pude completar el alta. Intenta de nuevo.";
    await sendStaffWhatsAppReply(admin, twilio, fromPhone, msg);
    return { handled: true };
  }

  await sendStaffWhatsAppReply(
    admin,
    twilio,
    fromPhone,
    buildStaffInviteAcceptedReply(redeemed.placeName),
  );
  return { handled: true };
}

/** WhatsApp Flow completed (twilio/flows or whatsapp/flows). */
export async function tryAcceptStaffInviteFromFlow(opts: {
  admin: SupabaseClient;
  twilio: TwilioEnv;
  fromPhone: string;
  params: Record<string, string>;
}): Promise<{ handled: boolean }> {
  const token = extractStaffInviteFlowToken(opts.params);
  const invite = token
    ? await findPendingStaffInviteByToken(opts.admin, token)
    : await findPendingStaffInviteForPhone(opts.admin, opts.fromPhone);

  if (!invite) {
    if (token) {
      await sendStaffWhatsAppReply(
        opts.admin,
        opts.twilio,
        opts.fromPhone,
        "No veo una invitación activa para este número. Pide a tu manager que te vuelva a invitar.",
      );
      return { handled: true };
    }
    return { handled: false };
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

  await sendStaffWhatsAppReply(
    admin,
    twilio,
    fromPhone,
    `${invite.place_name} te invitó al equipo. Si quieres unirte, responde sí (o escribe sí quiero).`,
  );
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
