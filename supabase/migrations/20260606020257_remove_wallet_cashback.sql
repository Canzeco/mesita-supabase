-- Remove the cashback / wallet model entirely. Mesita is discounts-only.
--
-- The live discount mechanic already runs on the discount_* columns and the
-- four per-cell *_rate columns (welcome_free_rate, welcome_premium_rate,
-- free_rate, premium_rate). The parallel cashback_* columns, the wallet
-- ledger, the stored balance, and the ledger enum are legacy and dropped.
-- No view, trigger, or non-reset function references any of them.

-- 1. Wallet ledger (+ its RLS policy via cascade) and the stored balance.
drop table if exists public.cashback_ledger cascade;
alter table public.consumers drop column if exists cashback_balance_cents;

-- 2. Legacy formal-flow snapshots on tickets (discount_cents / discount_percent supersede them).
alter table public.tickets drop column if exists cashback_cents;
alter table public.tickets drop column if exists cashback_percent;

-- 3. Legacy single venue rate (the four *_rate cells supersede it).
alter table public.venues drop column if exists cashback_percent;

-- 4. Ledger enum (was only used by cashback_ledger).
drop type if exists public.cashback_kind;

-- 5. Reset function: stop truncating the dropped ledger.
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
    public.venues,
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

  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (
       select lower(email) from public.super_admins
     );
  get diagnostics deleted_users = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'preserved_media_assets', true,
    'reset_at', now()
  );
end;
$function$;
