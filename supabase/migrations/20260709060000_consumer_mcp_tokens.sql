-- ============================================================================
-- Consumer MCP tokens — personal access tokens so an external AI client
-- (Claude, ChatGPT, Cursor, any MCP client) can act as the signed-in
-- consumer via the Consumer MCP Edge Function.
--
-- Model: the Me → AI sheet mints a token (plaintext shown once). We store
-- only sha256(token) + a short prefix for UI. Revoke sets revoked_at.
-- The MCP endpoint authenticates with Authorization: Bearer <token>,
-- never a Supabase JWT.
--
-- EF-only table (service_role): RLS on, zero policies — the deliberate
-- lockdown pattern (accepted rls_enabled_no_policy INFO).
--
-- decision: Pato live — build Consumer MCP now (Notion Main §8 Potential
-- Expansions promoted). MESITA-265.
-- ============================================================================

create table if not exists public.consumer_mcp_tokens (
  id              uuid primary key default gen_random_uuid(),
  consumer_id     uuid not null references auth.users(id) on delete cascade,
  -- First 12 chars of the plaintext token (mesita_mcp_…) for Me UI lists.
  token_prefix    text not null,
  -- sha256 hex of the full plaintext token. Lookup key for MCP auth.
  token_hash      text not null unique,
  label           text not null default 'AI client',
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  constraint consumer_mcp_tokens_prefix_len check (char_length(token_prefix) between 8 and 24)
);

comment on table public.consumer_mcp_tokens is
  'Personal access tokens for the Consumer MCP. Plaintext shown once at mint; only sha256 hash stored. EF-only (service_role).';

create index if not exists consumer_mcp_tokens_consumer_idx
  on public.consumer_mcp_tokens (consumer_id, created_at desc);

create index if not exists consumer_mcp_tokens_hash_active_idx
  on public.consumer_mcp_tokens (token_hash)
  where revoked_at is null;

alter table public.consumer_mcp_tokens enable row level security;
revoke all on table public.consumer_mcp_tokens from anon, authenticated;
grant all on table public.consumer_mcp_tokens to service_role;

-- Keep admin_reset_database in sync (truncate list + consumer_mcp_tokens).
-- Body copied from 20260708150000 with only the new table added.
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
    public.consumer_mcp_tokens,
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
    'preserved_media_assets', true,
    'reset_at', now()
  );
end;
$function$;

notify pgrst, 'reload schema';
