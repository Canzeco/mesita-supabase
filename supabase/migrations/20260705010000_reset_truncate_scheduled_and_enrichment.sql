-- admin_reset_database(): close two content leaks in the environment reset.
--
-- The admin "Reset database" button wipes all operational content but keep
-- the super-admin allowlist. Two content tables were surviving every reset:
--
--   1. scheduled_project_creations — has NO foreign keys, so the TRUNCATE …
--      CASCADE never reaches it. Migration 20260626180000 added it to the list
--      under its old name (scheduled_unit_creations); the r2 rename
--      (20260626260000) renamed the table to scheduled_project_creations and
--      rebuilt this function WITHOUT re-adding it. Scheduled creations have
--      leaked across resets ever since.
--
--   2. place_enrichment_events — added 20260703130000. It IS emptied today via
--      cascade (FK → places, ON DELETE CASCADE), but the reset should not lean
--      on cascade for content it owns; listing it explicitly keeps the wipe
--      self-documenting and resilient to a future FK change.
--
-- Everything else in the body is unchanged from 20260704090000 (billing
-- surface): same reseeds, same auth.users purge, same return shape. This is a
-- content reset only — no tables or functions are dropped.

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

  insert into public.plans
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

  -- stripe_price_id is intentionally not overwritten: the reset rebuilds a
  -- clean working env but keeps the provisioned Stripe wiring.
  insert into public.business_plans (key, label, price_cents, currency) values
    ('pro',   'Promote', 10000,  'MXN'),
    ('ultra', 'Ultra',   500000, 'MXN')
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
