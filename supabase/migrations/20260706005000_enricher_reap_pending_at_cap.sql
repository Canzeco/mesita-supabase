-- ============================================================================
-- Enricher reaper gap (MESITA-123).
--
-- A stage crash releases its row back to status='pending' at the SAME stage
-- (attempts already bumped at claim time). Once attempts reaches the cap, the
-- claim loop's `attempts < 4` filter skips the row forever — but the lease
-- reap only rescues status='running' rows, so nothing ever moved it to the
-- terminal stage='failed' and the place stayed at content_status='generating'
-- indefinitely, with no failure surfaced anywhere. (Live case: Mochomos
-- Monterrey after 4x contents crashes, 2026-07-06.)
--
-- run_place_enrichment_stages() now also terminally fails 'pending' rows at
-- the attempts cap, PRESERVING the last crash error for the admin inspector;
-- the existing content_status='failed' flip then catches them. Body otherwise
-- unchanged from 20260705100000 (verified == cloud before this replace).
-- ============================================================================

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

  -- ── Crash-released rows at the attempts cap ('pending', attempts >= 4) can
  -- never be claimed again: fail them terminally, keeping the last crash
  -- error so the inspector shows WHY. ──
  update public.place_research
  set stage = 'failed',
      error = coalesce(error, 'max attempts reached')
  where status = 'pending'
    and stage in ('research','analysis','contents')
    and attempts >= 4;

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

-- create-or-replace preserves ACLs, but re-assert the lockdown (0028/0029 +
-- 20260706000139) so this file stands alone if replayed on a fresh DB.
revoke all on function public.run_place_enrichment_stages() from public;
revoke execute on function public.run_place_enrichment_stages() from anon, authenticated;
