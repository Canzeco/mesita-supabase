// Supabase Edge Function — business-invite-waiter
//
// Creates a staff_invites row and, for WhatsApp + phone, sends one session
// message from Mesita Ops. Staff accept by replying SI in WhatsApp (no links).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { buildStaffInviteWhatsAppBody } from "../_shared/staff-invite-message.ts";
import { newInviteToken } from "../_shared/tokens.ts";
import { readTwilioEnv, sendWhatsAppText } from "../_shared/twilio.ts";

type Body = {
  venueId?: string;
  channel?: "whatsapp" | "sms";
  phone?: string;
  redirectBase?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const body = await readJsonOr<Body>(req, {});
  const venueId = (body.venueId ?? "").trim();
  const channel = (body.channel ?? "whatsapp") as Body["channel"];
  const phone = normalisePhone(body.phone);
  const redirectBase = (body.redirectBase ?? "").trim().replace(/\/$/, "");
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (channel !== "whatsapp" && channel !== "sms") {
    return json({ ok: false, error: "channel must be whatsapp or sms" }, 400);
  }

  const admin = adminClient(envRes.env);
  const membership = await requireMembership(admin, authRes.user, venueId);
  if (!membership.ok) return membership.response;

  const venueRes = await admin
    .from("venues")
    .select("name")
    .eq("id", venueId)
    .maybeSingle();
  const venueName = venueRes.data?.name ?? "your venue";

  const token = newInviteToken();

  const insert = await admin
    .from("staff_invites")
    .insert({
      venue_id: venueId,
      token,
      phone,
      channel,
      created_by: authRes.user.id,
    })
    .select("id, token, phone, channel, expires_at")
    .single();
  if (insert.error) {
    return json({ ok: false, error: `invite_insert: ${insert.error.message}` }, 500);
  }

  const shareUrl = redirectBase
    ? `${redirectBase}/accept-invite?token=${encodeURIComponent(token)}&kind=waiter`
    : null;

  let sent = false;
  let sendError: string | null = null;
  let messageSid: string | null = null;

  if (channel === "whatsapp" && phone) {
    const twilio = readTwilioEnv();
    if (!twilio.ok) {
      sendError = twilio.error;
    } else {
      const wa = await sendWhatsAppText({
        env: twilio.env,
        from: twilio.env.whatsappFromStaff,
        to: phone,
        body: buildStaffInviteWhatsAppBody({ venueName }),
      });
      if (wa.ok) {
        sent = true;
        messageSid = wa.sid;
      } else {
        sendError = wa.error;
      }
    }
  } else if (channel === "whatsapp" && !phone) {
    sendError = "Add a phone number to send the WhatsApp invite automatically.";
  } else if (channel === "sms") {
    sendError =
      "SMS waiter invites are not enabled — use WhatsApp; staff accept by replying SI in Ops chat.";
  }

  return json({
    ok: true,
    inviteId: insert.data.id,
    token: insert.data.token,
    phone: insert.data.phone,
    channel: insert.data.channel,
    expiresAt: insert.data.expires_at,
    shareUrl,
    sent,
    sendError,
    messageSid,
  });
});

function normalisePhone(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^0-9+]/g, "");
  if (!/^\+?\d{7,15}$/.test(cleaned)) return null;
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}
