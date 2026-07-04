-- Business billing — the paid place plans (Promote + Ultra) become real
-- monthly Stripe subscriptions, and consumer Premium drops $200 → $100 MXN/mo.
--
-- 1. business_plans   — lookup for the paid place plans (business-side mirror
--    of public.plans): label, monthly price, currency, and the Stripe price id
--    the checkout EF uses. Keys match the public.membership enum ('pro',
--    'ultra'); 'free' has no row because it is not billable. stripe_price_id
--    starts null and is self-provisioned by the checkout EFs on first real
--    checkout (see functions/_shared/stripe-billing.ts).
-- 2. project_subscriptions — per-project Stripe subscription mirror (the
--    business-side counterpart of consumer_subscriptions). A project's plan
--    column stays the single source of truth for entitlement; this table only
--    mirrors billing state, so a plan granted through another door (admin,
--    partnership) is never coupled to Stripe.
-- 3. plans.premium price drops 20000 → 10000 cents ($100 MXN/month).
-- 4. admin_reset_database recreated: premium reseeds at 10000, business_plans
--    reseeds (preserving any provisioned stripe_price_id), and
--    project_subscriptions truncates with the rest.

-- ── 1. business_plans lookup ────────────────────────────────────────────────

create table if not exists public.business_plans (
  key             text primary key,
  label           text not null,
  price_cents     integer not null default 0,
  currency        text not null default 'MXN',
  stripe_price_id text,
  created_at      timestamptz not null default now()
);

-- Service-role only: businesses read plan pricing through Edge Functions.
alter table public.business_plans enable row level security;

insert into public.business_plans (key, label, price_cents, currency) values
  ('pro',   'Promote', 10000,  'MXN'),
  ('ultra', 'Ultra',   500000, 'MXN')
on conflict (key) do update set
  label       = excluded.label,
  price_cents = excluded.price_cents,
  currency    = excluded.currency;

-- ── 2. project_subscriptions mirror ─────────────────────────────────────────

create table if not exists public.project_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  project_id             uuid not null references public.projects(id) on delete cascade,
  plan_key               text not null references public.business_plans(key),
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  status                 text not null
    check (status in ('incomplete', 'active', 'past_due', 'canceled', 'unpaid')),
  price_cents            integer,
  currency               text not null default 'MXN',
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false
);

drop trigger if exists project_subscriptions_set_updated_at on public.project_subscriptions;
create trigger project_subscriptions_set_updated_at
  before update on public.project_subscriptions
  for each row execute function public.set_updated_at();

-- A project holds at most one live (active or past_due) subscription.
create unique index if not exists project_subscriptions_one_live
  on public.project_subscriptions (project_id)
  where status in ('active', 'past_due');

create index if not exists project_subscriptions_project_idx
  on public.project_subscriptions (project_id);

alter table public.project_subscriptions enable row level security;

-- Members of the project may read its subscription rows (mirrors
-- consumer_subscriptions_select_own). All writes are service-role only.
drop policy if exists project_subscriptions_select_member on public.project_subscriptions;
create policy project_subscriptions_select_member on public.project_subscriptions
  for select using (
    exists (
      select 1
      from public.project_members m
      where m.project_id = project_subscriptions.project_id
        and m.business_id = auth.uid()
    )
  );

-- ── 3. Consumer Premium price drop: $200 → $100 MXN / month ─────────────────

update public.plans set price_cents = 10000 where key = 'premium';

-- ── 4. admin_reset_database keeps the new billing surface ───────────────────

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
