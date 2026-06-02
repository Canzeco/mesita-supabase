// Persist Mesita Ops WhatsApp transcript; load last N for LLM context.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { normalizePhoneE164 } from "./phone.ts";
import { sendWhatsAppText, type TwilioEnv } from "./twilio.ts";

export const STAFF_WHATSAPP_HISTORY_LIMIT = 20;

export type StaffWhatsAppMessageRow = {
  direction: "inbound" | "outbound";
  body: string;
  created_at: string;
};

export async function appendStaffWhatsAppMessage(
  admin: SupabaseClient,
  opts: {
    phoneE164: string;
    direction: "inbound" | "outbound";
    body: string;
    twilioMessageSid?: string | null;
  },
): Promise<void> {
  const phone = normalizePhoneE164(opts.phoneE164);
  if (!phone) return;

  const text = opts.body.trim().slice(0, 4000);
  if (!text) return;

  const row: Record<string, unknown> = {
    phone_e164: phone,
    direction: opts.direction,
    body: text,
  };
  const sid = opts.twilioMessageSid?.trim();
  if (sid) row.twilio_message_sid = sid;

  const { error } = await admin.from("staff_whatsapp_messages").insert(row);
  if (error?.code === "23505") return;
  if (error) {
    console.warn("[staff-whatsapp-messages] insert failed", error.message);
  }
}

export async function loadStaffWhatsAppHistory(
  admin: SupabaseClient,
  phoneE164: string,
  limit = STAFF_WHATSAPP_HISTORY_LIMIT,
): Promise<StaffWhatsAppMessageRow[]> {
  const phone = normalizePhoneE164(phoneE164);
  if (!phone) return [];

  const { data, error } = await admin
    .from("staff_whatsapp_messages")
    .select("direction, body, created_at")
    .eq("phone_e164", phone)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data?.length) return [];
  return (data as StaffWhatsAppMessageRow[]).reverse();
}

export function formatStaffWhatsAppHistoryForLlm(
  rows: StaffWhatsAppMessageRow[],
): string {
  if (!rows.length) return "";
  const lines = rows.map((r) => {
    const who = r.direction === "inbound" ? "mesero" : "mesita";
    return `${who}: ${r.body.replace(/\s+/g, " ").trim()}`;
  });
  return lines.join("\n");
}

/** Load prior messages (excludes current turn), format for prompts. */
export async function loadStaffWhatsAppHistoryText(
  admin: SupabaseClient,
  phoneE164: string,
  priorLimit = STAFF_WHATSAPP_HISTORY_LIMIT - 1,
): Promise<string> {
  const prior = await loadStaffWhatsAppHistory(admin, phoneE164, priorLimit);
  return formatStaffWhatsAppHistoryForLlm(prior);
}

export async function sendStaffWhatsAppReply(
  admin: SupabaseClient,
  twilio: TwilioEnv,
  toPhoneE164: string,
  body: string,
): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  const send = await sendWhatsAppText({
    env: twilio,
    from: twilio.whatsappFromStaff,
    to: toPhoneE164,
    body,
  });
  if (send.ok) {
    await appendStaffWhatsAppMessage(admin, {
      phoneE164: toPhoneE164,
      direction: "outbound",
      body,
      twilioMessageSid: send.sid,
    });
  }
  return send;
}
