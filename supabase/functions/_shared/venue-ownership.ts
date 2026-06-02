// Claimed ownership = venue_members.role 'owner' (OTP / admin approval).
// listing_type 'partner' is a separate catalog/discovery flag, not ownership.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function venueHasVerifiedOwner(
  admin: SupabaseClient,
  venueId: string,
): Promise<boolean> {
  const { count, error } = await admin
    .from("venue_members")
    .select("id", { count: "exact", head: true })
    .eq("venue_id", venueId)
    .eq("role", "owner");
  if (error) return false;
  return (count ?? 0) > 0;
}
