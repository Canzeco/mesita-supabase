// Shared reservation column projection.
//
// The select list for a reservation row joined with the guest's display
// fields + plan (tier). NO financial fields — reservations never carry money
// (the entity split keeps discounts on tickets, not bookings). Shared so the
// list and confirm endpoints return an identical reservation shape.
export const RESERVATION_SELECT =
  "id, reserved_at, party_size, status, notes, confirmed_at, completed_at, cancelled_at, created_at, consumer:consumers(id, code, full_name, class_key, class_origin)";
