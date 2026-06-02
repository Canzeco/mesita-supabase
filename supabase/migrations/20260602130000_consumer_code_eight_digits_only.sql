-- Consumer codes are strictly 8 digits displayed as 0000-0000 … 9999-9999.
-- Retire legacy 6-char alphanumeric codes.

create or replace function public.normalize_consumer_code_input(raw text)
returns text
language plpgsql
immutable
set search_path to 'pg_catalog', 'public'
as $function$
declare
  digits text;
begin
  if raw is null or length(trim(raw)) = 0 then
    return null;
  end if;
  if trim(raw) ~ '^[0-9]{4}-[0-9]{4}$' then
    return trim(raw);
  end if;
  digits := regexp_replace(trim(raw), '[^0-9]', '', 'g');
  if length(digits) = 8 then
    return public.format_consumer_code(digits::bigint);
  end if;
  return null;
end;
$function$;

comment on function public.normalize_consumer_code_input(text) is
  'Parses staff/validator input into canonical 0000-0000 format. Returns null if not 8 digits.';

-- Replace legacy codes before enforcing the check constraint.
do $migrate$
declare
  r record;
  new_code text;
begin
  for r in
    select id from public.consumers
    where code is null or code !~ '^[0-9]{4}-[0-9]{4}$'
  loop
    new_code := public.generate_consumer_code();
    update public.consumers set code = new_code where id = r.id;
  end loop;
end;
$migrate$;

alter table public.consumers
  drop constraint if exists consumers_code_format_check;

alter table public.consumers
  add constraint consumers_code_format_check
  check (code ~ '^[0-9]{4}-[0-9]{4}$');

-- Keep admin_reset in sync (truncate Type-A tables + reset code counter).
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
    public.staff_whatsapp_sessions,
    public.consumer_subscriptions,
    public.stripe_events,
    public.reservations,
    public.coupons,
    public.saved_venues,
    public.cashback_ledger,
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
