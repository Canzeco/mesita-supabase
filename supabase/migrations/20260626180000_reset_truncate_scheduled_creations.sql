-- admin_reset_database(): add public.scheduled_unit_creations to the TRUNCATE
-- list so the super-admin reset rebuilds a genuinely clean working env.
--
-- The async create scheduler polls scheduled_unit_creations for pending rows and
-- fires atlas-run-scheduled-create. Before this change a reset wiped units/places
-- but LEFT the queue rows, so stale 'pending' creations were re-polled against an
-- empty catalog right after a reset. The table has no inbound FKs (place_id is
-- plain text), so truncating it cascades nothing.
--
-- Full create-or-replace (functions can't be patched in place); only the truncate
-- list changed (added scheduled_unit_creations). The 'preserved_media_assets'
-- flag is intentionally left as-is (known-inaccurate, do not re-fix).

create or replace function public.admin_reset_database()
returns jsonb language plpgsql security definer
set search_path to 'pg_catalog','public','auth' as $function$
declare
  deleted_users bigint;
begin
  truncate table
    public.ticket_reviews,
    public.consumer_pay_notifications,
    public.staff_whatsapp_messages,
    public.staff_whatsapp_sessions,
    public.consumer_subscriptions,
    public.stripe_events,
    public.reservations,
    public.coupons,
    public.saved_venues,
    public.tickets,
    public.venue_verifications,
    public.business_invites,
    public.staff_invites,
    public.venue_roles,
    public.venue_members,
    public.scheduled_unit_creations,
    public.units,
    public.places,
    public.consumers,
    public.businesses
  restart identity cascade;

  update public.consumer_code_counter set next_value = 0 where id = 1;

  insert into public.membership_tiers
    (key, label, rank, follower_threshold, monthly_reservation_limit, price_cents, currency, recommendation_weight)
  values
    ('free',    'Free',    0, null, 2,    0,     'MXN', 1.0),
    ('premium', 'Premium', 1, 1000, null, 20000, 'MXN', 1.5)
  on conflict (key) do update set
    label                     = excluded.label,
    rank                      = excluded.rank,
    follower_threshold        = excluded.follower_threshold,
    monthly_reservation_limit = excluded.monthly_reservation_limit,
    price_cents               = excluded.price_cents,
    currency                  = excluded.currency,
    recommendation_weight     = excluded.recommendation_weight;

  perform public.seed_venue_categories();
  perform public.seed_venue_tags();

  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (select lower(email) from public.super_admins);
  get diagnostics deleted_users = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'preserved_media_assets', true,
    'reset_at', now()
  );
end;
$function$;
