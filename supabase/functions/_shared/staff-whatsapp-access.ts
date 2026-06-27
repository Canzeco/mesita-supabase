// Staff phone → identity resolution for WhatsApp inbound.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { phoneDigits } from "./phone.ts";
import type {
  StaffAccess,
  StaffIdentity,
  StaffPlace,
} from "./staff-whatsapp-types.ts";

async function listStaffPlaces(
  admin: SupabaseClient,
  userId: string,
): Promise<StaffPlace[]> {
  const roleRows = await admin
    .from("project_roles")
    .select("project_id, places(name)")
    .eq("user_id", userId)
    .eq("role", "staff");
  if (roleRows.error || !roleRows.data?.length) return [];

  const places: StaffPlace[] = [];
  for (const row of roleRows.data) {
    const join = row.places as unknown as { name: string } | null;
    places.push({
      projectId: row.project_id,
      placeName: join?.name ?? "Place",
    });
  }
  places.sort((a, b) => a.placeName.localeCompare(b.placeName));
  return places;
}

/** Staff auth + place team membership for this WhatsApp number. */
export async function resolveStaffAccess(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<StaffAccess> {
  const digits = phoneDigits(phoneE164);
  const userIdRes = await admin.rpc("find_user_id_by_phone", {
    phone_digits: digits,
  });
  const userId = userIdRes.data as string | null;
  if (!userId) return { status: "unknown_phone" };

  const places = await listStaffPlaces(admin, userId);
  if (places.length === 0) return { status: "not_on_team" };

  return {
    status: "ok",
    identity: {
      staffUserId: userId,
      phoneE164,
      places,
    },
  };
}

/** @deprecated Use resolveStaffAccess */
export async function resolveStaffIdentity(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<StaffIdentity | null> {
  const access = await resolveStaffAccess(admin, phoneE164);
  return access.status === "ok" ? access.identity : null;
}
