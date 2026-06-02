// Outbound waiter invite — Twilio Content template (whatsapp/flows) with session fallback.

import {
  readStaffInviteContentSid,
  sendWhatsAppContent,
} from "./twilio-content.ts";
import { buildStaffInviteWhatsAppBody } from "./staff-invite-message.ts";
import {
  normaliseWhatsAppFrom,
  normaliseWhatsAppTo,
  sendWhatsAppText,
  type TwilioEnv,
} from "./twilio.ts";

export async function sendStaffInviteWhatsApp(opts: {
  env: TwilioEnv;
  toPhoneE164: string;
  venueName: string;
  inviteToken: string;
}): Promise<
  | { ok: true; sid: string; mode: "template" | "session" }
  | { ok: false; error: string; mode: "none" }
> {
  const { env, toPhoneE164, venueName, inviteToken } = opts;
  const from = env.whatsappFromStaff;
  const to = normaliseWhatsAppTo(toPhoneE164);

  const contentSid = readStaffInviteContentSid();
  if (contentSid) {
    const tpl = await sendWhatsAppContent({
      env,
      from: normaliseWhatsAppFrom(from),
      to,
      contentSid,
      contentVariables: {
        "1": venueName.slice(0, 200),
        // whatsapp/flows templates use {{2}} as flow_token; twilio/flows ignores it
        "2": inviteToken.slice(0, 128),
      },
    });
    if (tpl.ok) return { ok: true, sid: tpl.sid, mode: "template" };
    console.warn("[staff-invite-send] template failed, fallback session", tpl.error);
  }

  const session = await sendWhatsAppText({
    env,
    from,
    to: toPhoneE164,
    body: buildStaffInviteWhatsAppBody({ venueName }),
  });
  if (session.ok) return { ok: true, sid: session.sid, mode: "session" };
  return { ok: false, error: session.error, mode: "none" };
}
