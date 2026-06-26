-- ============================================================================
-- Staggered scheduler for the units/places create pipeline.
--
-- A queue (public.scheduled_unit_creations) + a pg_cron poller that every ~10s
-- claims a small batch of DUE rows (FOR UPDATE SKIP LOCKED, attempts < cap),
-- marks them 'running', and fires net.http_post (pg_net, ASYNC) at the
-- SERVICE-GATED internal create EF `atlas-run-scheduled-create`. That EF runs
-- get-enriched -> save-unit-data -> save-place-media and writes the row back to
-- 'done'/'failed'. The SAME poller also REAPS stuck 'running' rows (no EF
-- callback within the grace window) back to 'pending' (or 'failed' at the cap).
--
-- WHY a separate service-gated EF (not admin/business-create-unit): those are
-- JWT-gated natural callers; the poller is service-role with no user JWT, so it
-- targets an artificial caller (requireInternalCaller), exactly like every other
-- inter-EF call (invokeArtificialCaller) does.
--
-- SECRET: the service-role bearer the poller sends is read from Supabase VAULT
-- (vault.decrypted_secrets, name 'scheduler_service_role_key') — NEVER stored in
-- plaintext or in this migration. The operator seeds it ONCE (see bottom). The
-- target URL is the project's standard /functions/v1 path (not secret), matching
-- invokeArtificialCaller's convention.
--
-- This migration sets up everything EXCEPT the secret; until the operator seeds
-- it, the poller logs a warning and no-ops (no rows are processed).
-- ============================================================================

create extension if not exists pg_cron with schema pg_catalog;
-- pg_net (net.*) is already installed; vault (vault.*) ships with Supabase.

-- ── Queue table ─────────────────────────────────────────────────────────────
create table if not exists public.scheduled_unit_creations (
  id             uuid primary key default gen_random_uuid(),
  place_id       text not null,                -- the Google Places placeId to create
  exec_at        timestamptz not null default now(),
  status         text not null default 'pending'
                 check (status in ('pending','running','done','failed')),
  attempts       int not null default 0,
  net_request_id bigint,                       -- pg_net id → join to net._http_response (6h)
  result         jsonb,
  error          text,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists scheduled_unit_creations_status_exec_at_idx
  on public.scheduled_unit_creations (status, exec_at);
-- The reaper scans 'running' rows by updated_at.
create index if not exists scheduled_unit_creations_running_updated_idx
  on public.scheduled_unit_creations (status, updated_at);

alter table public.scheduled_unit_creations enable row level security;
-- Service-role only: no anon/authenticated policy = denied. The schedule EFs and
-- the internal create EF all touch this table through the service-role key.
revoke all on public.scheduled_unit_creations from anon, authenticated;
grant all on public.scheduled_unit_creations to service_role;

-- updated_at auto-bump (reuse the shared trigger fn) — lets the reaper tell an
-- actively-progressing row from a genuinely stuck one.
drop trigger if exists scheduled_unit_creations_set_updated_at on public.scheduled_unit_creations;
create trigger scheduled_unit_creations_set_updated_at
  before update on public.scheduled_unit_creations
  for each row execute function public.set_updated_at();

-- ── Poller + reaper ─────────────────────────────────────────────────────────
-- SECURITY DEFINER so cron (running as the job owner) reads the Vault secret +
-- writes the queue. set search_path includes net (http_post) + vault (secrets).
create or replace function public.run_scheduled_unit_creations()
returns integer
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_key   text;
  v_url   text := 'https://yjalywfzdelacdzccpgb.supabase.co/functions/v1/atlas-run-scheduled-create';
  v_row   public.scheduled_unit_creations%rowtype;
  v_req   bigint;
  v_count integer := 0;
begin
  -- ── REAP first: a 'running' row whose EF never reported back within 5 min ──
  -- attempts was already bumped at claim time; under the cap → retry, at/over the
  -- cap → terminal 'failed' so a poison placeId can't loop forever.
  update public.scheduled_unit_creations
  set status = case when attempts >= 5 then 'failed' else 'pending' end,
      error  = case when attempts >= 5 then 'max attempts reached' else 'reaped: stuck running' end
  where status = 'running'
    and updated_at < now() - interval '5 minutes';

  -- ── Service bearer from Vault (seeded ONCE by the operator) ──
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'scheduler_service_role_key'
  limit 1;
  if v_key is null then
    raise warning 'run_scheduled_unit_creations: vault secret scheduler_service_role_key missing — seed it (see migration footer)';
    return 0;
  end if;

  -- ── Claim a small batch of DUE, under-cap rows. SKIP LOCKED lets overlapping
  --    10s ticks each grab a disjoint set instead of blocking/double-firing. ──
  for v_row in
    select *
    from public.scheduled_unit_creations
    where status = 'pending'
      and exec_at <= now()
      and attempts < 5
    order by exec_at asc
    for update skip locked
    limit 3
  loop
    -- Async POST — net.http_post returns a request id immediately and delivers
    -- the call out of band; atlas-run-scheduled-create writes the row's terminal
    -- status. Capture the request id so a failure can be traced to net._http_response.
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key,
        'X-Internal-Caller', 'scheduler-poller'
      ),
      body    := jsonb_build_object('placeId', v_row.place_id, 'scheduled_id', v_row.id),
      timeout_milliseconds := 120000
    ) into v_req;

    update public.scheduled_unit_creations
    set status = 'running',
        attempts = attempts + 1,
        net_request_id = v_req,
        error = null
    where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Revoke from PUBLIC (not just anon/authenticated): Postgres grants EXECUTE to
-- PUBLIC by default, so revoking only anon/authenticated leaves the function
-- callable via PostgREST RPC. The pg_cron job runs as the owner, so it is
-- unaffected. (Supabase linter 0028/0029.)
revoke all on function public.run_scheduled_unit_creations() from public;

-- ── Schedules: poller every 10s + a daily cron-history cleanup ──────────────
-- Idempotent: drop any prior schedule of the same name before (re)adding.
select cron.unschedule('run-scheduled-unit-creations')
where exists (select 1 from cron.job where jobname = 'run-scheduled-unit-creations');
select cron.schedule(
  'run-scheduled-unit-creations',
  '10 seconds',
  $cron$ select public.run_scheduled_unit_creations(); $cron$
);

-- cron.job_run_details is NOT auto-pruned and a 10s job writes ~8.6k rows/day.
select cron.unschedule('prune-cron-run-details')
where exists (select 1 from cron.job where jobname = 'prune-cron-run-details');
select cron.schedule(
  'prune-cron-run-details',
  '0 4 * * *',
  $cron$ delete from cron.job_run_details where end_time < now() - interval '7 days'; $cron$
);

-- ----------------------------------------------------------------------------
-- ONE-TIME OPERATOR SEED (run once after apply; the key is NOT in version control):
--
--   select vault.create_secret(
--     '<the value the EFs see for SUPABASE_SERVICE_ROLE_KEY>',
--     'scheduler_service_role_key'
--   );
--
-- The bearer MUST equal the value atlas-run-scheduled-create reads from
-- Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') — requireInternalCaller compares them
-- exactly (constant-time). This is the same key every inter-EF invokeArtificialCaller
-- already uses, so use the project's service-role key from the dashboard. If the
-- seeded key is wrong, the poller's rows land 'failed' with 'Internal call
-- rejected' (observable in scheduled_unit_creations.error) — never silent.
-- ----------------------------------------------------------------------------

notify pgrst, 'reload schema';
