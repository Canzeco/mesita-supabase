// Supabase Edge Function — business-web-invite-staff
//
// One pending invite per place + phone. Re-invite resends WhatsApp on the same row.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJsonOr, readPlaceIdAlias } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { normalizePhoneE164, phonesMatch } from "../_shared/phone.ts";
import { sendStaffInviteWhatsApp } from "../_shared/staff-invite-send.ts";
import { newInviteToken } from "../_shared/tokens.ts";
import { readTwilioEnv } from "../_shared/twilio.ts";

type Body = {
  /** Canonical place-row id key (MESITA-26); `projectId` kept as legacy alias. */
  placeId?: string;
  projectId?: string;
  channel?: "whatsapp" | "sms";
  phone?: string;
  redirectBase?: string;
};

const INVITE_TTL_DAYS = 14;

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
  const projectId = readPlaceIdAlias(body);
  const channel = (body.channel ?? "whatsapp") as Body["channel"];
  const phone = normalizePhoneE164(body.phone);
  const redirectBase = (body.redirectBase ?? "").trim().replace(/\/$/, "");
  if (!projectId) return json({ ok: false, error: "projectId is required" }, 400);
  if (channel !== "whatsapp" && channel !== "sms") {
    return json({ ok: false, error: "channel must be whatsapp or sms" }, 400);
  }

  const admin = adminClient(envRes.env);
  const membership = await requireMembership(admin, authRes.user, projectId);
  if (!membership.ok) return membership.response;

  const placeRes = await admin
    .from("projects_view")
    .select("name")
    .eq("id", projectId)
    .maybeSingle();
  const placeName = placeRes.data?.name ?? "tu restaurante";

  if (phone) {
    const onTeam = await isPhoneAlreadyStaffAtPlace(admin, projectId, phone);
    if (onTeam) {
      return json(
        {
          ok: false,
          code: "already_member",
          error: "Ese número ya está en el equipo de este local.",
        },
        409,
      );
    }
  }

  const expiresAt = new Date(
    Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  let inviteRow: {
    id: string;
    token: string;
    phone: string | null;
    channel: string;
    expires_at: string;
  };
  let resent = false;

  if (phone) {
    const existing = await findPendingStaffInviteForPlacePhone(
      admin,
      projectId,
      phone,
    );
    if (existing) {
      const token = newInviteToken();
      const updated = await admin
        .from("staff_invites")
        .update({
          token,
          channel,
          expires_at: expiresAt,
        })
        .eq("id", existing.id)
        .select("id, token, phone, channel, expires_at")
        .single();
      if (updated.error) {
        return json(
          { ok: false, error: `invite_update: ${updated.error.message}` },
          500,
        );
      }
      inviteRow = updated.data;
      resent = true;
    } else {
      const inserted = await insertStaffInvite(admin, {
        projectId,
        phone,
        channel,
        createdBy: authRes.user.id,
        expiresAt,
      });
      if (!inserted.ok) return inserted.response;
      inviteRow = inserted.row;
    }
  } else {
    const inserted = await insertStaffInvite(admin, {
      projectId,
      phone: null,
      channel,
      createdBy: authRes.user.id,
      expiresAt,
    });
    if (!inserted.ok) return inserted.response;
    inviteRow = inserted.row;
  }

  const shareUrl = redirectBase
    ? `${redirectBase}/accept-invite?token=${encodeURIComponent(inviteRow.token)}&kind=waiter`
    : null;

  const sendResult = await trySendWaiterInviteWhatsApp({
    admin,
    channel,
    phone,
    placeName,
    inviteToken: inviteRow.token,
  });

  return json({
    ok: true,
    inviteId: inviteRow.id,
    token: inviteRow.token,
    phone: inviteRow.phone,
    channel: inviteRow.channel,
    expiresAt: inviteRow.expires_at,
    shareUrl,
    resent,
    sent: sendResult.sent,
    sendError: sendResult.sendError,
    messageSid: sendResult.messageSid,
    sendMode: sendResult.sendMode,
  });
});

async function insertStaffInvite(
  admin: SupabaseClient,
  opts: {
    projectId: string;
    phone: string | null;
    channel: string;
    createdBy: string;
    expiresAt: string;
  },
): Promise<
  | {
      ok: true;
      row: {
        id: string;
        token: string;
        phone: string | null;
        channel: string;
        expires_at: string;
      };
    }
  | { ok: false; response: Response }
> {
  const token = newInviteToken();
  const insert = await admin
    .from("staff_invites")
    .insert({
      project_id: opts.projectId,
      token,
      phone: opts.phone,
      channel: opts.channel,
      created_by: opts.createdBy,
      expires_at: opts.expiresAt,
    })
    .select("id, token, phone, channel, expires_at")
    .single();

  if (insert.error) {
    if (opts.phone && insert.error.code === "23505") {
      const existing = await findPendingStaffInviteForPlacePhone(
        admin,
        opts.projectId,
        opts.phone,
      );
      if (existing) {
        const updated = await admin
          .from("staff_invites")
          .update({
            token: newInviteToken(),
            channel: opts.channel,
            expires_at: opts.expiresAt,
          })
          .eq("id", existing.id)
          .select("id, token, phone, channel, expires_at")
          .single();
        if (!updated.error && updated.data) {
          return { ok: true, row: updated.data };
        }
      }
    }
    return {
      ok: false,
      response: json(
        { ok: false, error: `invite_insert: ${insert.error.message}` },
        500,
      ),
    };
  }

  return { ok: true, row: insert.data };
}

async function findPendingStaffInviteForPlacePhone(
  admin: SupabaseClient,
  projectId: string,
  phoneE164: string,
): Promise<{ id: string } | null> {
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from("staff_invites")
    .select("id, phone")
    .eq("project_id", projectId)
    .is("claimed_at", null)
    .gt("expires_at", nowIso)
    .not("phone", "is", null);

  if (error || !data?.length) return null;
  for (const row of data) {
    if (row.phone && phonesMatch(row.phone, phoneE164)) {
      return { id: row.id };
    }
  }
  return null;
}

async function isPhoneAlreadyStaffAtPlace(
  admin: SupabaseClient,
  projectId: string,
  phoneE164: string,
): Promise<boolean> {
  const digits = phoneE164.replace(/\D/g, "");
  const { data: userId, error } = await admin.rpc("find_user_id_by_phone", {
    phone_digits: digits,
  });
  if (error || !userId) return false;

  const { data: role } = await admin
    .from("project_roles")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("role", "staff")
    .maybeSingle();

  return !!role;
}

async function trySendWaiterInviteWhatsApp(opts: {
  admin: SupabaseClient;
  channel: Body["channel"];
  phone: string | null;
  placeName: string;
  inviteToken: string;
}): Promise<{
  sent: boolean;
  sendError: string | null;
  messageSid: string | null;
  sendMode: "template" | "session" | null;
}> {
  const { admin, channel, phone, placeName, inviteToken } = opts;
  if (channel !== "whatsapp" || !phone) {
    if (channel === "whatsapp" && !phone) {
      return {
        sent: false,
        sendError: "Agrega un número para enviar la invitación por WhatsApp.",
        messageSid: null,
        sendMode: null,
      };
    }
    if (channel === "sms") {
      return {
        sent: false,
        sendError:
          "Las invitaciones por SMS no están activas — usa WhatsApp; el mesero responde sí en Mesita Ops.",
        messageSid: null,
        sendMode: null,
      };
    }
    return { sent: false, sendError: null, messageSid: null, sendMode: null };
  }

  const twilio = readTwilioEnv();
  if (!twilio.ok) {
    return {
      sent: false,
      sendError: twilio.error,
      messageSid: null,
      sendMode: null,
    };
  }

  const wa = await sendStaffInviteWhatsApp({
    admin,
    env: twilio.env,
    toPhoneE164: phone,
    placeName,
    inviteToken,
  });
  if (wa.ok) {
    return {
      sent: true,
      sendError: null,
      messageSid: wa.sid,
      sendMode: wa.mode,
    };
  }
  return {
    sent: false,
    sendError: wa.error,
    messageSid: null,
    sendMode: null,
  };
}
