-- consumer_pay_notifications: EF-only reads for clients.
--
-- Pay inbox data is served by consumer-list-pay-notifications (service role).
-- Drop the authenticated SELECT policy and remove Realtime publication so
-- browsers cannot read the table directly.

drop policy if exists consumer_pay_notifications_select_own
  on public.consumer_pay_notifications;

-- ALTER PUBLICATION has no IF EXISTS clause; guard via pg_publication_tables.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'consumer_pay_notifications'
  ) then
    alter publication supabase_realtime drop table public.consumer_pay_notifications;
  end if;
end
$$;
