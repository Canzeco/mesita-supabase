// Outbound waiter invite — approved twilio/text template, else session (same copy).

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  readStaffInviteContentSid,
  sendWhatsAppContent,
} from "./twilio-content.ts";
import { buildStaffInviteWhatsAppBody } from "./staff-invite-message.ts";
import { appendStaffWhatsAppMessage } from "./staff-whatsapp-messages.ts";
import {
  normaliseWhatsAppFrom,
  normaliseWhatsAppTo,
  sendWhatsAppText,
  type TwilioEnv,
} from "./twilio.ts";

export async function sendStaffInviteWhatsApp(opts: {
  admin?: SupabaseClient;
  env: TwilioEnv;
  toPhoneE164: string;
  placeName: string;
  inviteToken: string;
}): Promise<
  | { ok: true; sid: string; mode: "template" | "session" }
  | { ok: false; error: string; mode: "none" }
> {
  const { admin, env, toPhoneE164, placeName } = opts;
  const from = env.whatsappFromStaff;
  const to = normaliseWhatsAppTo(toPhoneE164);
  const body = buildStaffInviteWhatsAppBody({ placeName });

  const contentSid = readStaffInviteContentSid();
  if (contentSid) {
    const tpl = await sendWhatsAppContent({
      env,
      from: normaliseWhatsAppFrom(from),
      to,
      contentSid,
      contentVariables: {
        "1": placeName.slice(0, 200),
      },
    });
    if (tpl.ok) {
      if (admin) {
        await appendStaffWhatsAppMessage(admin, {
          phoneE164: toPhoneE164,
          direction: "outbound",
          body,
          twilioMessageSid: tpl.sid,
        });
      }
      return { ok: true, sid: tpl.sid, mode: "template" };
    }
    console.warn("[staff-invite-send] template failed, fallback session", tpl.error);
  }

  const session = await sendWhatsAppText({
    env,
    from,
    to: toPhoneE164,
    body,
  });
  if (session.ok) {
    if (admin) {
      await appendStaffWhatsAppMessage(admin, {
        phoneE164: toPhoneE164,
        direction: "outbound",
        body,
        twilioMessageSid: session.sid,
      });
    }
    return { ok: true, sid: session.sid, mode: "session" };
  }
  return { ok: false, error: session.error, mode: "none" };
}
