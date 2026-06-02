// Twilio Content API — approved WhatsApp templates & flows (ContentSid).

import {
  normaliseWhatsAppFrom,
  normaliseWhatsAppTo,
  type TwilioEnv,
} from "./twilio.ts";

export type WhatsAppTemplateSend = {
  contentSid: string;
  contentVariables?: Record<string, string>;
};

export function readStaffInviteContentSid(): string | null {
  const sid = Deno.env.get("TWILIO_CONTENT_SID_STAFF_INVITE")?.trim();
  return sid && sid.startsWith("HX") ? sid : null;
}

export async function sendWhatsAppContent(opts: {
  env: TwilioEnv;
  from: string;
  to: string;
  contentSid: string;
  contentVariables?: Record<string, string>;
}): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  const { env, from, to, contentSid, contentVariables } = opts;
  const auth = btoa(`${env.accountSid}:${env.authToken}`);
  const form = new URLSearchParams({
    From: normaliseWhatsAppFrom(from),
    To: normaliseWhatsAppTo(to.replace(/^whatsapp:/i, "")),
    ContentSid: contentSid,
  });
  if (contentVariables && Object.keys(contentVariables).length > 0) {
    form.set("ContentVariables", JSON.stringify(contentVariables));
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { message?: string }).message ?? res.statusText;
    return { ok: false, error: msg };
  }
  return { ok: true, sid: (data as { sid: string }).sid };
}
