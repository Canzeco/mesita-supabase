// Shared types for the staff WhatsApp Type A flow.

export type StaffVenue = {
  venueId: string;
  venueName: string;
};

export type StaffIdentity = {
  staffUserId: string;
  phoneE164: string;
  venues: StaffVenue[];
};

export type StaffContext = StaffIdentity & {
  venueId: string;
  venueName: string;
};

export type SessionRow = {
  id: string;
  phone_e164: string;
  staff_user_id: string;
  venue_id: string | null;
  state: string;
  consumer_id: string | null;
  ticket_id: string | null;
  pending_consumer_code: string | null;
  context: Record<string, unknown>;
};

export type VenueOption = { venue_id: string; name: string };

export type StaffAccess =
  | { status: "ok"; identity: StaffIdentity }
  | { status: "unknown_phone" }
  | { status: "not_on_team" };
