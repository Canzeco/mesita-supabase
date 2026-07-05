-- Nomenclature split: businesses have PLANS (free/pro/ultra); consumers have CLASSES (free/premium).
-- Business plan display label retires "Promote" in favour of "Pro".
-- The enum type `membership` is intentionally kept (the product-facing column is already
-- `projects.plan`); only the consumer-side "plan/tier" wording becomes "class".

-- 1. Consumer lookup table: plans -> classes
alter table public.plans rename to classes;
alter policy "membership_tiers_select_all" on public.classes rename to "classes_select_all";

-- 2. Consumer class columns on consumers: tier_* -> class_*
alter table public.consumers rename column tier_key        to class_key;
alter table public.consumers rename column tier_origin     to class_origin;
alter table public.consumers rename column tier_granted_at to class_granted_at;
alter table public.consumers rename column tier_expires_at to class_expires_at;

-- 3. Business plan display label: retire "Promote" -> "Pro"
update public.business_plans set label = 'Pro' where key = 'pro';

-- 4. Rebuild admin_reset_database to seed the renamed classes table and the "Pro" label
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
    public.projects,
    public.places,
    public.consumers,
    public.accounts
  restart identity cascade;

  update public.consumer_code_counter set next_value = 0 where id = 1;

  -- Consumer classes (free / premium)
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

  -- Business plans (free / pro / ultra). stripe_price_id intentionally preserved.
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
