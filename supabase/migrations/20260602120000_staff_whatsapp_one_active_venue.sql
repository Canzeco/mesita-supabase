-- One WhatsApp number → one active venue at a time (staff may belong to many units).
-- While selecting a unit, venue_id is null and state = selecting_venue.

alter table public.staff_whatsapp_sessions
  alter column venue_id drop not null;

alter table public.staff_whatsapp_sessions
  drop constraint if exists staff_whatsapp_sessions_state_check;

alter table public.staff_whatsapp_sessions
  add constraint staff_whatsapp_sessions_state_check
  check (state in (
    'selecting_venue',
    'idle',
    'consumer_identified',
    'awaiting_payment_confirm',
    'awaiting_staff_payment_confirm'
  ));

alter table public.staff_whatsapp_sessions
  add constraint staff_whatsapp_sessions_venue_when_active
  check (state = 'selecting_venue' or venue_id is not null);

comment on table public.staff_whatsapp_sessions is
  'Staff WhatsApp session per phone (unique). venue_id is the single active unit for this number; use selecting_venue when the waiter must pick among multiple team venues.';
