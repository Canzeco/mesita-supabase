// Payment confirmation + ticket finalization for staff WhatsApp Type A.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  finalizeInformalTicket,
  venueInstagramHandleForPayload,
} from "./ticket-informal.ts";
import { sendStaffWhatsAppReply } from "./staff-whatsapp-messages.ts";
import { type TwilioEnv } from "./twilio.ts";

export async function onConsumerPaymentConfirmed(
  admin: SupabaseClient,
  twilio: TwilioEnv | null,
  ticketId: string,
  consumerId: string,
): Promise<void> {
  const ticket = await admin
    .from("tickets")
    .select(
      "id, venue_id, staff_payment_confirmed_at, status, opened_by_staff_user_id",
    )
    .eq("id", ticketId)
    .eq("consumer_id", consumerId)
    .maybeSingle();
  if (!ticket.data || ticket.data.status !== "awaiting_payment_confirm") return;

  const venueRes = await admin
    .from("venues")
    .select("name")
    .eq("id", ticket.data.venue_id)
    .single();

  if (ticket.data.staff_payment_confirmed_at) {
    await tryFinalizeAndReview(
      admin,
      ticketId,
      consumerId,
      ticket.data.venue_id,
    );

    if (twilio && ticket.data.opened_by_staff_user_id) {
      const staffPhone = await staffPhoneForUser(
        admin,
        ticket.data.opened_by_staff_user_id,
      );
      if (staffPhone) {
        await sendStaffWhatsAppReply(
          admin,
          twilio,
          staffPhone,
          `El comensal confirmó el pago en ${venueRes.data?.name ?? "tu local"} ✓\n` +
            `Responde listo cuando hayas cobrado.`,
        );
      }
    }
    return;
  }

  if (twilio && ticket.data.opened_by_staff_user_id) {
    const staffPhone = await staffPhoneForUser(
      admin,
      ticket.data.opened_by_staff_user_id,
    );
    if (staffPhone) {
      await sendStaffWhatsAppReply(
        admin,
        twilio,
        staffPhone,
        `El comensal confirmó en la app (${venueRes.data?.name ?? "local"}).\n` +
          `Responde listo cuando cobres.`,
      );
    }
  }
}

export async function tryFinalizeAndReview(
  admin: SupabaseClient,
  ticketId: string,
  consumerId: string,
  venueId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fin = await finalizeInformalTicket(admin, ticketId, consumerId, venueId);
  if (!fin.ok) return fin;
  await enqueueReview(admin, consumerId, ticketId, venueId);
  return { ok: true };
}

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

async function enqueueReview(
  admin: SupabaseClient,
  consumerId: string,
  ticketId: string,
  venueId: string,
) {
  const [venueRes, ticketRes] = await Promise.all([
    admin
      .from("venues")
      .select("name, slug, photos, instagram_url")
      .eq("id", venueId)
      .single(),
    admin
      .from("tickets")
      .select(
        "discount_cents, redeem_cents, discount_percent, total_cents, check_subtotal_cents, tip_cents",
      )
      .eq("id", ticketId)
      .single(),
  ]);
  const v = venueRes.data;
  const t = ticketRes.data;
  const discount = t?.discount_cents ?? 0;
  const redeem = t?.redeem_cents ?? 0;
  await admin.from("consumer_pay_notifications").insert({
    consumer_id: consumerId,
    ticket_id: ticketId,
    kind: "review",
    status: "pending",
    payload: {
      venue_id: venueId,
      venue_slug: v?.slug ?? null,
      venue_name: v?.name ?? "Partner venue",
      venue_photo_url: v?.photos?.[0] ?? null,
      venue_instagram_handle: venueInstagramHandleForPayload(v?.instagram_url),
      discount_cents: discount,
      discount_percent: t?.discount_percent ?? null,
      redeem_cents: redeem,
      total_reward_cents: discount + redeem,
      total_cents: t?.total_cents ?? null,
      currency: "MXN",
    },
  });
}

async function staffPhoneForUser(
  admin: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const session = await admin
    .from("staff_whatsapp_sessions")
    .select("phone_e164")
    .eq("staff_user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (session.data?.phone_e164) return session.data.phone_e164;

  const { data } = await admin.auth.admin.getUserById(userId);
  const phone = data.user?.phone;
  if (!phone) return null;
  return phone.startsWith("+") ? phone : `+${phone}`;
}
