-- consumer_pay_notifications: EF-only reads for clients.
--
-- Pay inbox data is served by consumer-list-pay-notifications (service role).
-- Drop the authenticated SELECT policy and remove Realtime publication so
-- browsers cannot read the table directly.

drop policy if exists consumer_pay_notifications_select_own
  on public.consumer_pay_notifications;

alter publication supabase_realtime drop table if exists public.consumer_pay_notifications;
