// Ticket opener resolution for the Staff WhatsApp flow.
//
// Reward tickets close at billing (Type A) or story verification (Type B) —
// there is no payment-confirmation handshake anymore (Mesita never holds
// money), so this module only resolves who "owns" an opened ticket.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function resolveTicketOpener(
  admin: SupabaseClient,
  venueId: string,
  staffUserId: string,
): Promise<string> {
  const owner = await admin
    .from("venue_members")
    .select("business_id")
    .eq("venue_id", venueId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  if (owner.data?.business_id) return owner.data.business_id;
  return staffUserId;
}
