-- ============================================================================
-- Consumer create quota — per-consumer attempts ledger (abuse guard).
--
-- consumer-web-create-place (+ its consumer-web-schedule-project-creation
-- compat alias) had no per-user bound: a scripted consumer account could
-- create unlimited DISTINCT places, each burning a Google Basics call up
-- front plus a full Enricher pipeline run (real Apify/Firecrawl/Perplexity/
-- OpenAI budget) and polluting the catalog. The google_place_id unique index
-- only dedupes the SAME place.
--
-- Model: the consumer EFs record one row per create ATTEMPT (before any
-- Google spend) and reject with 429 once the rolling 24 h count exceeds the
-- quota (_shared/create-quota.ts). Insert-then-count keeps parallel bursts
-- self-limiting — N simultaneous requests each see the whole burst.
--
-- EF-only table (service_role): RLS on, zero policies — the deliberate
-- lockdown pattern (accepted rls_enabled_no_policy INFO).
-- ============================================================================

create table if not exists public.place_creation_attempts (
  id              bigint generated always as identity primary key,
  consumer_id     uuid not null references auth.users(id) on delete cascade,
  google_place_id text not null,
  caller          text not null,
  created_at      timestamptz not null default now()
);

comment on table public.place_creation_attempts is
  'Per-consumer place-create attempts ledger: the consumer create EFs insert one row per attempt and enforce a rolling 24 h quota against it (_shared/create-quota.ts). EF-only (service_role).';

create index if not exists place_creation_attempts_consumer_created_idx
  on public.place_creation_attempts (consumer_id, created_at desc);

alter table public.place_creation_attempts enable row level security;
revoke all on table public.place_creation_attempts from anon, authenticated;
grant all on table public.place_creation_attempts to service_role;

-- ── admin_reset_database(): 20260706020000 body + place_creation_attempts ────
-- Recreated from the LATEST body (20260706020000_drop_creation_queue — classes
-- + 'Pro' label + place_media_assets) with only the new ledger added to the
-- truncate list. Never copy an older body (that exact mistake reintroduced
-- public.plans and broke every reset).
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
    public.place_creation_attempts,
    public.place_media_assets,
    public.place_research,
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
