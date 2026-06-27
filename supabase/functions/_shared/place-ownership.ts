// Claimed ownership = project_members.role 'owner' (OTP / admin approval).
// listing_type 'partner' is a separate catalog/discovery flag, not ownership.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function placeHasVerifiedOwner(
  admin: SupabaseClient,
  projectId: string,
): Promise<boolean> {
  const { count, error } = await admin
    .from("project_members")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("role", "owner");
  if (error) return false;
  return (count ?? 0) > 0;
}

export async function isLastOwnerOfPlace(
  admin: SupabaseClient,
  projectId: string,
): Promise<boolean> {
  const { count } = await admin
    .from("project_members")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("role", "owner");
  return (count ?? 0) <= 1;
}
