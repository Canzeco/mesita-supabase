// Supabase Edge Function — staff-accept-invite
//
// Legacy web redeem (token). Prefer WhatsApp: reply SI on Mesita Ops.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { clean } from "../_shared/input.ts";
import { redeemStaffInvite } from "../_shared/staff-invite-redeem.ts";

type Body = { token?: string | null };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const user = authRes.user.raw;

  if (!user.phone) {
    return json(
      { ok: false, error: "Staff invites are redeemed by phone-authed users." },
      400,
    );
  }

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const token = clean(body.token, 128);
  if (!token) {
    return json({ ok: false, error: "Missing invite token" }, 400);
  }

  const admin = adminClient(envRes.env);

  const invite = await admin
    .from("staff_invites")
    .select(
      "id, venue_id, phone, claimed_at, expires_at, created_by, venues(name)",
    )
    .eq("token", token)
    .maybeSingle();
  if (invite.error) {
    return json({ ok: false, error: `invite_read: ${invite.error.message}` }, 500);
  }
  if (!invite.data) {
    return json({ ok: false, error: "Invite not found or already revoked." }, 404);
  }
  if (invite.data.claimed_at) {
    return json({ ok: false, error: "This invite was already claimed." }, 409);
  }
  if (new Date(invite.data.expires_at).getTime() < Date.now()) {
    return json({ ok: false, error: "This invite has expired." }, 410);
  }
  if (invite.data.phone && invite.data.phone !== user.phone) {
    return json(
      { ok: false, error: "This invite is bound to a different phone number." },
      403,
    );
  }

  const join = invite.data.venues as { name: string } | null;
  const redeemed = await redeemStaffInvite(admin, {
    invite: {
      id: invite.data.id,
      venue_id: invite.data.venue_id,
      phone: invite.data.phone,
      claimed_at: invite.data.claimed_at,
      expires_at: invite.data.expires_at,
      created_by: invite.data.created_by,
      venue_name: join?.name ?? "your venue",
    },
    userId: user.id,
  });
  if (!redeemed.ok) {
    return json({ ok: false, error: redeemed.error }, 500);
  }

  return json({
    ok: true,
    role: "staff",
    venue_id: redeemed.venueId,
  });
});
