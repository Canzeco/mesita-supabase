-- ============================================================================
-- Consumer create-place quota — bound per-consumer place creation spend.
--
-- consumer-web-create-place (and its consumer-web-schedule-project-creation
-- compat alias) had NO per-user bound: any authenticated consumer could script
-- unlimited creates with distinct googlePlaceIds. Every call burns a Google
-- Places Basics call (fetchGoogleBasics runs before any insert) and seeds a
-- full Enricher pipeline run (~$0.35+/place per the enrich-config rate card).
-- The google_place_id dedupe only guards the SAME place, not different ones.
--
-- Fix: a small attempts ledger + a rolling-window quota enforced inside
-- _shared/create-place.ts (after the cheap dedupe, BEFORE fetchGoogleBasics,
-- so an over-quota call spends nothing). The EF inserts the attempt row FIRST
-- and then counts the window — under parallel scripted requests every racer
-- sees its own row, so at most `limit` creates can proceed regardless of
-- concurrency. Duplicate-place clicks 409 before the quota check and never
-- burn quota.
--
-- Attempts (not successes) are what's counted: a failed Google lookup still
-- billed a Basics call, so it must consume quota too. No FK to auth.users —
-- this is a spend ledger; rows outliving a deleted account are harmless and
-- an FK would couple account deletion to it for no benefit.
--
-- Access model matches place_research: RLS on, no policies, service_role only
-- (EF-only lockdown — the advisor rls_enabled_no_policy INFO is deliberate).
-- ============================================================================

create table if not exists public.place_creation_attempts (
  id              bigint generated always as identity primary key,
  user_id         uuid not null,
  google_place_id text not null,
  caller          text not null,
  created_at      timestamptz not null default now()
);

comment on table public.place_creation_attempts is
  'Per-user place-creation spend ledger: one row per create attempt that reached the paid path (past dedupe). Backs the rolling-24h consumer quota in _shared/create-place.ts.';

create index if not exists place_creation_attempts_user_recent_idx
  on public.place_creation_attempts (user_id, created_at desc);

alter table public.place_creation_attempts enable row level security;
revoke all on public.place_creation_attempts from anon, authenticated;
grant all on public.place_creation_attempts to service_role;

-- ── admin_reset_database(): 20260706020000 body + place_creation_attempts in
-- the truncate list (quota must not carry over into a freshly reset env).
-- Never copy an older body — that exact mistake reintroduced public.plans
-- once and the 'Promote' label another time.
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
    public.place_enrichment_events,
    public.place_media_assets,
    public.place_research,
    public.place_creation_attempts,
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

  -- stripe_price_id is intentionally not overwritten: the reset rebuilds a
  -- clean working env but keeps the provisioned Stripe wiring.
  insert into public.business_plans (key, label, price_cents, currency) values
    ('pro',   'Pro',     10000,  'MXN'),
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
    -- Known-inaccurate flag, intentionally left true per prior decision
    -- (media assets are in fact truncated); not re-fixed here.
    'preserved_media_assets', true,
    'reset_at', now()
  );
end;
$function$;

notify pgrst, 'reload schema';
