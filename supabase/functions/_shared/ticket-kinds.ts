// Ticket-kind taxonomy used by business-web-create-ticket, business-web-submit-ticket-bill,
// and business-web-verify-story. Single source of truth so a new flow added
// to one EF can't drift from the others.
//
// Mesita is discounts-only: every ticket is a discount ("dp") flow, with an
// optional Instagram-story step ("_sf") for Instagram-door Premium consumers,
// optionally linked to a reservation ("r_"). Pure sets — no DB reads, no I/O.

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

// Every kind that produces a ticket row (i.e. everything except `none`).
export const ACTIONABLE_KINDS = new Set([
  "dp",
  "s_dp_sf",
  "r_dp",
  "r_s_dp_sf",
]);
