// Staff phone → identity resolution for WhatsApp inbound.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type {
  StaffAccess,
  StaffIdentity,
  StaffVenue,
} from "./staff-whatsapp-types.ts";

async function listStaffVenues(
  admin: SupabaseClient,
  userId: string,
): Promise<StaffVenue[]> {
  const roleRows = await admin
    .from("venue_roles")
    .select("venue_id, venues(name)")
    .eq("user_id", userId)
    .eq("role", "staff");
  if (roleRows.error || !roleRows.data?.length) return [];

  const venues: StaffVenue[] = [];
  for (const row of roleRows.data) {
    const join = row.venues as unknown as { name: string } | null;
    venues.push({
      venueId: row.venue_id,
      venueName: join?.name ?? "Venue",
    });
  }
  venues.sort((a, b) => a.venueName.localeCompare(b.venueName));
  return venues;
}

/** Staff auth + venue team membership for this WhatsApp number. */
export async function resolveStaffAccess(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<StaffAccess> {
  const digits = phoneE164.replace(/\D/g, "");
  const userIdRes = await admin.rpc("find_user_id_by_phone", {
    phone_digits: digits,
  });
  const userId = userIdRes.data as string | null;
  if (!userId) return { status: "unknown_phone" };

  const venues = await listStaffVenues(admin, userId);
  if (venues.length === 0) return { status: "not_on_team" };

  return {
    status: "ok",
    identity: {
      staffUserId: userId,
      phoneE164,
      venues,
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
