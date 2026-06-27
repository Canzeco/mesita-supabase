// Shared types for the staff WhatsApp Type A flow.

export type StaffPlace = {
  projectId: string;
  placeName: string;
};

export type StaffIdentity = {
  staffUserId: string;
  phoneE164: string;
  places: StaffPlace[];
};

export type StaffContext = StaffIdentity & {
  projectId: string;
  placeName: string;
};

export type SessionRow = {
  id: string;
  phone_e164: string;
  staff_user_id: string;
  project_id: string | null;
  state: string;
  consumer_id: string | null;
  ticket_id: string | null;
  pending_consumer_code: string | null;
  context: Record<string, unknown>;
};

export type PlaceOption = { project_id: string; name: string };

export type StaffAccess =
  | { status: "ok"; identity: StaffIdentity }
  | { status: "unknown_phone" }
  | { status: "not_on_team" };
