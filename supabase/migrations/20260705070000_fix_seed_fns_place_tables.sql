-- Fix admin_reset_database(): its seed helpers still insert into the pre-rename
-- table names and abort every reset.
--
-- 20260626260000 (R2 renames) renamed venue_categories→place_categories and
-- venue_tags→place_tags, then renamed seed_venue_categories()→seed_place_categories()
-- and seed_venue_tags()→seed_place_tags() with plain `alter function … rename`.
-- That renamed the functions but never rewrote their BODIES, so both still run
-- `insert into public.venue_categories` / `public.venue_tags` — relations that no
-- longer exist. (Contrast sync_place_category_label() in the same migration, which
-- was correctly `create or replace`d onto the renamed table.) Since
-- admin_reset_database() calls both seed helpers, every reset has aborted with
-- `relation "public.venue_categories" does not exist` since 2026-06-26.
--
-- Fix: retarget each seed function's single table reference to the renamed table,
-- preserving the catalog VALUES verbatim by rewriting the live definition rather
-- than re-listing 100 rows (immune to catalog drift; correct for cloud + fresh
-- rebuilds since place_categories/place_tags already exist at this point).

do $$
declare
  src text;
begin
  src := pg_get_functiondef('public.seed_place_categories()'::regprocedure);
  execute replace(src, 'public.venue_categories', 'public.place_categories');

  src := pg_get_functiondef('public.seed_place_tags()'::regprocedure);
  execute replace(src, 'public.venue_tags', 'public.place_tags');
end $$;
