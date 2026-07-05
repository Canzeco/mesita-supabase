// Ticket-kind taxonomy used by business-web-create-ticket, business-web-submit-ticket-bill,
// business-web-verify-story, and the Staff WhatsApp flow. Single source of truth
// so a new flow added to one EF can't drift from the others.
//
// Two layers:
//
//  1. WIRE KINDS — what clients (business console scan picker, Staff WhatsApp)
//     send / what an EF reasons about. Mesita is discounts-only: every ticket is
//     a discount ("dp") flow, with an optional Instagram-story step ("_sf") for
//     Instagram-door Premium consumers, optionally linked to a reservation
//     ("r_"). These encode two orthogonal booleans (story, reservation).
//
//  2. DB ENUM — the persisted `public.ticket_kind` column was collapsed to
//     `reservation | coupon` (MESITA-62). The story dimension now lives entirely
//     in the `story_status` column and the reservation dimension in
//     `reservation_status`, so `kind` only distinguishes reservation vs coupon.
//     Every writer MUST map its wire kind through `toDbTicketKind` before insert.
//
// Pure sets / pure function — no DB reads, no I/O.

/** Persisted `public.ticket_kind` enum values. */
export type DbTicketKind = "reservation" | "coupon";

export const STORY_KINDS = new Set([
  "s_dp_sf",
  "r_s_dp_sf",
]);

// Alias for callers that specifically mean "discount + story".
export const INFORMAL_STORY_KINDS = new Set([
  "s_dp_sf",
  "r_s_dp_sf",
]);

export const RESERVATION_KINDS = new Set([
  "r_dp",
  "r_s_dp_sf",
]);

// Every wire kind that produces a ticket row (i.e. everything except `none`).
export const ACTIONABLE_KINDS = new Set([
  "dp",
  "s_dp_sf",
  "r_dp",
  "r_s_dp_sf",
]);

/**
 * Map a wire kind to the persisted `public.ticket_kind` enum. Reservation-linked
 * flows (r_ prefix) persist as `reservation`; every other discount flow persists
 * as `coupon`. The story step is orthogonal — it is carried by `story_status`,
 * not by `kind` — so it does not affect this mapping.
 */
export function toDbTicketKind(wireKind: string): DbTicketKind {
  return RESERVATION_KINDS.has(wireKind) ? "reservation" : "coupon";
}
