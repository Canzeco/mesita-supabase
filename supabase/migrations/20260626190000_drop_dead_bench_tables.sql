-- Phase 0 (kill dead): drop the ADEA benchmark fixture tables.
-- 0 references anywhere — no EF, FK, trigger, DB function, or client reads them;
-- the bench-* EFs that consumed them are already gone. Not in the reset truncate
-- list, so admin_reset_database() needs no change.
drop table if exists public.bench_results;
drop table if exists public.bench_restaurants;

notify pgrst, 'reload schema';
