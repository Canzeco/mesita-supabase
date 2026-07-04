-- Fix (2026-07-03): the pg_cron job was still invoking the pre-rename
-- function name run_scheduled_unit_creations(), which no longer exists —
-- the job had been failing every 10 seconds since the R2 rename.
-- Recreate it under run_scheduled_project_creations().

do $$
begin
  if exists (select 1 from cron.job where jobname = 'run-scheduled-unit-creations') then
    perform cron.unschedule('run-scheduled-unit-creations');
  end if;
  if not exists (select 1 from cron.job where jobname = 'run-scheduled-project-creations') then
    perform cron.schedule(
      'run-scheduled-project-creations',
      '10 seconds',
      ' select public.run_scheduled_project_creations(); '
    );
  end if;
end
$$;
