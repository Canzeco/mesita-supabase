-- MESITA-54: flip the scheduler poller to the renamed EF slug.
-- scheduler-run-project-creations → supabase-cron-run-project-creations
-- (actor-origin grammar: the platform's own pg_cron poller is the caller).
--
-- ⚠️ Ordering: the supabase-cron-run-project-creations EF must be DEPLOYED
-- to cloud BEFORE this migration is applied, else the 10s cron 404s until
-- the deploy lands. The old slug stays live until the MESITA-59 cleanup.
--
-- The pg_cron job itself ('run-scheduled-project-creations', every 10s,
-- select public.run_scheduled_project_creations()) is unchanged — only the
-- EF URL inside the polled function body moves. Grants (service-only,
-- revoked from public/anon/authenticated in 20260626162000) are preserved
-- because CREATE OR REPLACE keeps the existing function's ACL.

create or replace function public.run_scheduled_project_creations()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'net', 'vault'
as $function$
declare
  v_key   text;
  v_url   text := 'https://yjalywfzdelacdzccpgb.supabase.co/functions/v1/supabase-cron-run-project-creations';
  v_row   public.scheduled_project_creations%rowtype;
  v_req   bigint;
  v_count integer := 0;
begin
  -- REAP first: 'running' rows whose EF never reported back within 5 min.
  update public.scheduled_project_creations
  set status = case when attempts >= 5 then 'failed' else 'pending' end,
      error  = case when attempts >= 5 then 'max attempts reached' else 'reaped: stuck running' end
  where status = 'running'
    and updated_at < now() - interval '5 minutes';

  -- Service bearer from Vault (seeded ONCE by the operator).
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'scheduler_service_role_key'
  limit 1;
  if v_key is null then
    raise warning 'run_scheduled_project_creations: vault secret scheduler_service_role_key missing — seed it (see migration footer)';
    return 0;
  end if;

  -- Claim a small batch of DUE, under-cap rows.
  for v_row in
    select *
    from public.scheduled_project_creations
    where status = 'pending'
      and exec_at <= now()
      and attempts < 5
    order by exec_at asc
    for update skip locked
    limit 3
  loop
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key,
        'X-Internal-Caller', 'supabase-cron'
      ),
      -- googlePlaceId, not placeId: scheduled_project_creations.place_id is a
      -- Google Place ID, and 'placeId' is reserved for place-row UUIDs
      -- platform-wide (MESITA-51 addendum 9).
      body    := jsonb_build_object('googlePlaceId', v_row.place_id, 'scheduled_id', v_row.id),
      timeout_milliseconds := 120000
    ) into v_req;

    update public.scheduled_project_creations
    set status = 'running',
        attempts = attempts + 1,
        net_request_id = v_req,
        error = null
    where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;
