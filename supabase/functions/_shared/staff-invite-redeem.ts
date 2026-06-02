// Redeem staff_invites — shared by staff-accept-invite (web) and Ops WhatsApp.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type PendingStaffInvite = {
  id: string;
  venue_id: string;
  phone: string | null;
  claimed_at: string | null;
  expires_at: string;
  created_by: string;
  venue_name: string;
};

export function phoneDigits(e164: string): string {
  return e164.replace(/\D/g, "");
}

export function phonesMatch(a: string, b: string): boolean {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  return da.slice(-10) === db.slice(-10);
}

/** Guest/staff accept keywords (no links). */
export function isStaffInviteAcceptMessage(body: string): boolean {
  const t = body.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (!t) return false;
  const words = new Set(
    t.split(/[\s,.!?;:]+/).filter((w) => w.length > 0),
  );
  const accept = new Set([
    "si",
    "sí",
    "yes",
    "y",
    "acepto",
    "accept",
    "ok",
    "vale",
    "listo",
    "join",
    "unirme",
    "entro",
  ]);
  if (words.size <= 3) {
    for (const w of words) {
      if (accept.has(w)) return true;
    }
  }
  if (/^(si|yes|acepto|accept|ok|vale|listo)\b/.test(t)) return true;
  return false;
}

export async function findPendingStaffInviteByToken(
  admin: SupabaseClient,
  token: string,
): Promise<PendingStaffInvite | null> {
  const t = token.trim();
  if (!t) return null;
  const { data, error } = await admin
    .from("staff_invites")
    .select(
      "id, venue_id, phone, claimed_at, expires_at, created_by, venues(name)",
    )
    .eq("token", t)
    .is("claimed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !data) return null;
  const join = data.venues as { name: string } | null;
  return {
    id: data.id,
    venue_id: data.venue_id,
    phone: data.phone,
    claimed_at: data.claimed_at,
    expires_at: data.expires_at,
    created_by: data.created_by,
    venue_name: join?.name ?? "your venue",
  };
}

export async function findPendingStaffInviteForPhone(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<PendingStaffInvite | null> {
  const digits = phoneDigits(phoneE164);
  const { data, error } = await admin
    .from("staff_invites")
    .select(
      "id, venue_id, phone, claimed_at, expires_at, created_by, venues(name)",
    )
    .is("claimed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error || !data?.length) return null;

  for (const row of data) {
    if (!row.phone) continue;
    if (!phonesMatch(row.phone, phoneE164)) continue;
    const join = row.venues as { name: string } | null;
    return {
      id: row.id,
      venue_id: row.venue_id,
      phone: row.phone,
      claimed_at: row.claimed_at,
      expires_at: row.expires_at,
      created_by: row.created_by,
      venue_name: join?.name ?? "your venue",
    };
  }

  return null;
}

export async function ensureAuthUserForStaffPhone(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const digits = phoneDigits(phoneE164);
  const existing = await admin.rpc("find_user_id_by_phone", {
    phone_digits: digits,
  });
  const userId = existing.data as string | null;
  if (userId) return { ok: true, userId };

  const created = await admin.auth.admin.createUser({
    phone: phoneE164,
    phone_confirm: true,
    app_metadata: { role: "staff" },
  });
  if (created.error) {
    return { ok: false, error: created.error.message };
  }
  if (!created.data.user?.id) {
    return { ok: false, error: "create_user_missing_id" };
  }
  return { ok: true, userId: created.data.user.id };
}

export async function redeemStaffInvite(
  admin: SupabaseClient,
  opts: { invite: PendingStaffInvite; userId: string },
): Promise<
  | { ok: true; venueId: string; venueName: string }
  | { ok: false; error: string; code: string }
> {
  const { invite, userId } = opts;
  if (invite.claimed_at) {
    return { ok: false, error: "already_claimed", code: "claimed" };
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "expired", code: "expired" };
  }
  const upsert = await admin
    .from("venue_roles")
    .upsert(
      {
        user_id: userId,
        venue_id: invite.venue_id,
        role: "staff",
        invited_by: invite.created_by,
      },
      { onConflict: "user_id,venue_id", ignoreDuplicates: false },
    )
    .select("user_id, venue_id, role")
    .single();
  if (upsert.error) {
    return { ok: false, error: upsert.error.message, code: "venue_roles" };
  }

  const claim = await admin
    .from("staff_invites")
    .update({ claimed_at: new Date().toISOString(), claimed_by: userId })
    .eq("id", invite.id)
    .is("claimed_at", null);
  if (claim.error) {
    return { ok: false, error: claim.error.message, code: "claim" };
  }

  const { data: userData } = await admin.auth.admin.getUserById(userId);
  const currentRole =
    (userData.user?.app_metadata as Record<string, unknown> | null)?.role as
      | string
      | undefined;
  if (currentRole !== "business" && currentRole !== "admin") {
    const stamp = await admin.auth.admin.updateUserById(userId, {
      app_metadata: {
        ...(userData.user?.app_metadata ?? {}),
        role: "staff",
      },
    });
    if (stamp.error) {
      return { ok: false, error: stamp.error.message, code: "role_stamp" };
    }
  }

  return { ok: true, venueId: invite.venue_id, venueName: invite.venue_name };
}

export function buildStaffInviteAcceptedReply(venueName: string): string {
  return (
    `Listo — ya estás en ${venueName}.\n\n` +
    `Envía el código del comensal (0000-0000), luego SUBTOTAL y PROPINA.\n` +
    `Cuando paguen: CONFIRM. HELP si necesitas ayuda.`
  );
}
