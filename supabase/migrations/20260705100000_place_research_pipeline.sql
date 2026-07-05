-- ============================================================================
-- Enricher v2 — cron-driven enrichment pipeline (MESITA-90).
--
-- The Enricher is a PROCESS now (not an n8n agent): three Edge Functions
-- (supabase-cron-enrich-place-{research,analysis,contents}) walk a place
-- through stages on a place_research row. The create EFs seed the row
-- (stage='research'); this poller claims pending rows per stage and fires
-- ONE async net.http_post per row at the matching stage EF, exactly like
-- run_scheduled_project_creations does for creates.
--
-- Stage machine:
--   research  → S1–S4: Google spine gate + Apify/Perplexity/Firecrawl gather
--   analysis  → S5–S6: vision describe + rank + final photo selection
--   contents  → S7–S9: synthesis + category + tags + persist + store images
--   done / failed — terminal.
--
-- Retry model: a stage EF acks immediately and works in the background; when
-- it finishes it advances the row (status='pending', next stage, attempts=0)
-- or releases it (status='pending', same stage) for a retry. A crashed run
-- leaves the row 'running'; the reaper below flips it back to 'pending' after
-- the lease window. attempts is bumped at claim time; at the cap the row goes
-- terminal 'failed' and the place's content_status is flipped to 'failed' so
-- it never strands at 'generating'.
--
-- SECRET: reuses the Vault secret 'scheduler_service_role_key' (seeded once
-- for the creation scheduler — same service-role bearer the stage EFs verify
-- via requireInternalCaller).
-- ============================================================================

-- ── Pipeline state table ─────────────────────────────────────────────────────
create table if not exists public.place_research (
  project_id      uuid primary key references public.places(id) on delete cascade,
  google_place_id text not null,
  stage           text not null default 'research'
                  check (stage in ('research','analysis','contents','done','failed')),
  status          text not null default 'pending'
                  check (status in ('pending','running')),
  attempts        int not null default 0,
  -- Research output: partial place update + grounding + candidate image pools.
  gathered        jsonb,
  -- Analysis output: ranked/selected photos + per-image vision descriptions.
  analysis        jsonb,
  error           text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.place_research is
  'Enricher v2 pipeline state: one row per place walking research → analysis → contents. gathered/analysis jsonb are the stage handoffs (kept after done for cheap re-synthesis).';

create index if not exists place_research_stage_status_idx
  on public.place_research (stage, status, updated_at);

alter table public.place_research enable row level security;
revoke all on public.place_research from anon, authenticated;
grant all on public.place_research to service_role;

drop trigger if exists place_research_set_updated_at on public.place_research;
create trigger place_research_set_updated_at
  before update on public.place_research
  for each row execute function public.set_updated_at();

-- ── Poller + reaper ──────────────────────────────────────────────────────────
create or replace function public.run_place_enrichment_stages()
returns integer
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_key   text;
  v_base  text := 'https://yjalywfzdelacdzccpgb.supabase.co/functions/v1/supabase-cron-enrich-place-';
  v_row   public.place_research%rowtype;
  v_stage text;
  v_req   bigint;
  v_count integer := 0;
begin
  -- ── REAP: 'running' rows whose EF never reported back within the lease
  -- (10 min > the 400 s EF wall clock, so a live run is never stolen).
  -- attempts was bumped at claim time; at/over the cap → terminal 'failed'. ──
  update public.place_research
  set status = 'pending',
      stage  = case when attempts >= 4 then 'failed' else stage end,
      error  = case when attempts >= 4 then 'max attempts reached' else 'reaped: stuck running' end
  where status = 'running'
    and stage in ('research','analysis','contents')
    and updated_at < now() - interval '10 minutes';

  -- A newly-failed pipeline must not strand its place at 'generating'.
  update public.projects p
  set content_status = 'failed'
  from public.place_research r
  where r.project_id = p.id
    and r.stage = 'failed'
    and p.content_status = 'generating';

  -- ── Service bearer from Vault (shared with the creation scheduler). ──
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'scheduler_service_role_key'
  limit 1;
  if v_key is null then
    raise warning 'run_place_enrichment_stages: vault secret scheduler_service_role_key missing';
    return 0;
  end if;

  -- ── Claim + fire, per stage. SKIP LOCKED keeps overlapping ticks disjoint.
  -- Small per-stage batches: the stage EFs each burn real API budget. ──
  foreach v_stage in array array['research','analysis','contents'] loop
    for v_row in
      select *
      from public.place_research
      where stage = v_stage
        and status = 'pending'
        and attempts < 4
      order by updated_at asc
      for update skip locked
      limit 2
    loop
      select net.http_post(
        url     := v_base || v_stage,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_key,
          'X-Internal-Caller', 'supabase-cron'
        ),
        body    := jsonb_build_object('project_id', v_row.project_id),
        timeout_milliseconds := 30000
      ) into v_req;

      update public.place_research
      set status = 'running',
          attempts = attempts + 1,
          error = null
      where project_id = v_row.project_id;

      v_count := v_count + 1;
    end loop;
  end loop;

  return v_count;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default; the cron job runs as the
-- function owner and is unaffected by the revoke. (Supabase linter 0028/0029.)
revoke all on function public.run_place_enrichment_stages() from public;

-- ── Schedule: stage poller every 20 seconds ──────────────────────────────────
select cron.unschedule('run-place-enrichment-stages')
where exists (select 1 from cron.job where jobname = 'run-place-enrichment-stages');
select cron.schedule(
  'run-place-enrichment-stages',
  '20 seconds',
  $cron$ select public.run_place_enrichment_stages(); $cron$
);

-- ── admin_reset_database(): wipe place_research explicitly ───────────────────
-- It IS emptied via cascade (FK → places, ON DELETE CASCADE), but the reset
-- lists content tables it owns explicitly (see 20260705010000's rationale for
-- place_enrichment_events). Body otherwise unchanged from 20260705010000.
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
    public.place_research,
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

notify pgrst, 'reload schema';
