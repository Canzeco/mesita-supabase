-- admin_reset_database(): re-add the two content tables that leak on reset,
-- rebased on top of the plan→class nomenclature (20260705020000).
--
-- Ordering matters: 20260705010000 first added scheduled_project_creations +
-- place_enrichment_events to the truncate list, but 20260705020000
-- (plans→classes rename) rebuilt the function from the pre-fix body and dropped
-- them again. This migration is timestamped after both, so the final function
-- carries BOTH the class nomenclature and the two content tables — regardless
-- of merge order.
--
-- scheduled_project_creations has NO foreign key, so TRUNCATE … CASCADE never
-- reaches it; without this it survives every reset. place_enrichment_events is
-- cascade-wiped via places today but is listed explicitly so the reset does not
-- rely on cascade for content it owns.
--
-- Content reset only — no tables or functions dropped. Seeds public.classes
-- (the renamed consumer lookup) and business_plans ('Pro' label) to match the
-- nomenclature migration.

create or replace function public.admin_reset_database()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public', 'auth'
as $function$
declare
  deleted_users bigint;
begin
  truncate table
    public.ticket_reviews,
    public.consumer_pay_notifications,
    public.staff_whatsapp_messages,
    public.staff_whatsapp_sessions,
    public.consumer_subscriptions,
    public.project_subscriptions,
    public.stripe_events,
    public.reservations,
    public.coupons,
    public.saved_places,
    public.tickets,
    public.project_verifications,
    public.account_invites,
    public.staff_invites,
    public.project_roles,
    public.project_members,
    public.scheduled_project_creations,
    public.place_enrichment_events,
    public.projects,
    public.places,
    public.consumers,
    public.accounts
  restart identity cascade;

  update public.consumer_code_counter set next_value = 0 where id = 1;

  insert into public.classes
    (key, label, rank, follower_threshold, monthly_reservation_limit, price_cents, currency, recommendation_weight)
  values
    ('free',    'Free',    0, null, 2,    0,     'MXN', 1.0),
    ('premium', 'Premium', 1, 1000, null, 10000, 'MXN', 1.5)
  on conflict (key) do update set
    label                     = excluded.label,
    rank                      = excluded.rank,
    follower_threshold        = excluded.follower_threshold,
    monthly_reservation_limit = excluded.monthly_reservation_limit,
    price_cents               = excluded.price_cents,
    currency                  = excluded.currency,
    recommendation_weight     = excluded.recommendation_weight;

  -- stripe_price_id intentionally preserved on conflict.
  insert into public.business_plans (key, label, price_cents, currency) values
    ('pro',   'Pro',   10000,  'MXN'),
    ('ultra', 'Ultra', 500000, 'MXN')
  on conflict (key) do update set
    label       = excluded.label,
    price_cents = excluded.price_cents,
    currency    = excluded.currency;

  perform public.seed_place_categories();
  perform public.seed_place_tags();

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
