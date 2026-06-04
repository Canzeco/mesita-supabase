// Supabase Edge Function — business-confirm-reservation
//
// Authenticated. The venue confirms or declines a reservation. Membership-
// gated and scoped to the venue (the update is filtered by venue_id) so a
// member can only act on that venue's bookings. Mirrors the reservation
// lifecycle: pending/confirmed -> confirmed | declined.
//
// Deploy: supabase functions deploy business-confirm-reservation

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";

const RESERVATION_SELECT =
  "id, reserved_at, party_size, status, notes, confirmed_at, completed_at, cancelled_at, created_at, consumer:consumers(id, code, full_name, tier_key, tier_origin)";

type Decision = "confirm" | "decline";
type Body = { venueId?: string; reservationId?: string; decision?: Decision };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const venueId = (body.venueId ?? "").toString().trim();
  const reservationId = (body.reservationId ?? "").toString().trim();
  const decision = body.decision;
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (!reservationId) {
    return json({ ok: false, error: "reservationId is required" }, 400);
  }
  if (decision !== "confirm" && decision !== "decline") {
    return json({ ok: false, error: "decision must be confirm or decline" }, 400);
  }

  const admin = adminClient(envRes.env);
  const memberRes = await requireMembership(admin, authRes.user, venueId);
  if (!memberRes.ok) return memberRes.response;

  const nowIso = new Date().toISOString();
  const patch =
    decision === "confirm"
      ? { status: "confirmed", confirmed_at: nowIso, updated_at: nowIso }
      : { status: "declined", updated_at: nowIso };

  // Scope the update to this venue and to still-actionable states so a
  // member can't flip a terminal booking (declined / no_show / cancelled).
  const { data, error } = await admin
    .from("reservations")
    .update(patch)
    .eq("id", reservationId)
    .eq("venue_id", venueId)
    .in("status", ["pending", "confirmed"])
    .select(RESERVATION_SELECT)
    .maybeSingle();

  if (error) return json({ ok: false, error: error.message }, 500);
  if (!data) {
    return json(
      { ok: false, error: "Reservation not found or no longer actionable" },
      404,
    );
  }
  return json({ ok: true, reservation: data });
});
