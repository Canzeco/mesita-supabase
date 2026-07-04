// Redeem staff_invites — consumed by the Ops WhatsApp flow
// (twilio-whatsapp-inbound via _shared/staff-invite-whatsapp.ts).

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { phoneDigits, phonesMatch } from "./phone.ts";

export type PendingStaffInvite = {
  id: string;
  project_id: string;
  phone: string | null;
  claimed_at: string | null;
  expires_at: string;
  created_by: string;
  place_name: string;
};

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
    "dale",
    "va",
    "claro",
    "entro",
    "quiero",
  ]);
  if (/^(si|sí)\s*(quiero|acepto|gracias)?\b/.test(t)) return true;
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
      "id, project_id, phone, claimed_at, expires_at, created_by, places(name)",
    )
    .eq("token", t)
    .is("claimed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !data) return null;
  const join = data.places as unknown as { name: string } | null;
  return {
    id: data.id,
    project_id: data.project_id,
    phone: data.phone,
    claimed_at: data.claimed_at,
    expires_at: data.expires_at,
    created_by: data.created_by,
    place_name: join?.name ?? "your place",
  };
}

export async function findPendingStaffInviteForPhone(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<PendingStaffInvite | null> {
  const { data, error } = await admin
    .from("staff_invites")
    .select(
      "id, project_id, phone, claimed_at, expires_at, created_by, places(name)",
    )
    .is("claimed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error || !data?.length) return null;

  for (const row of data) {
    if (!row.phone) continue;
    if (!phonesMatch(row.phone, phoneE164)) continue;
    const join = row.places as unknown as { name: string } | null;
    return {
      id: row.id,
      project_id: row.project_id,
      phone: row.phone,
      claimed_at: row.claimed_at,
      expires_at: row.expires_at,
      created_by: row.created_by,
      place_name: join?.name ?? "your place",
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
  | { ok: true; projectId: string; placeName: string }
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
    .from("project_roles")
    .upsert(
      {
        user_id: userId,
        project_id: invite.project_id,
        role: "staff",
        invited_by: invite.created_by,
      },
      { onConflict: "user_id,project_id", ignoreDuplicates: false },
    )
    .select("user_id, project_id, role")
    .single();
  if (upsert.error) {
    return { ok: false, error: upsert.error.message, code: "project_roles" };
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

  return { ok: true, projectId: invite.project_id, placeName: invite.place_name };
}

export function buildStaffInviteAcceptedReply(placeName: string): string {
  return (
    `Perfecto — ya quedaste en ${placeName}.\n\n` +
    `Cuando tengas un comensal, manda su código Mesita (0000-0000) y después la cuenta ` +
    `(por ejemplo SUBTOTAL 850 PROPINA 100). Cuando cobres, responde listo.\n\n` +
    `Escribe ayuda cuando quieras un recordatorio.`
  );
}
