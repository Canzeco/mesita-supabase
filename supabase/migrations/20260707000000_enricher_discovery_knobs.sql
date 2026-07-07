-- Enricher rebuild (MESITA-197) — new discovery + image-preselection knobs.
--
--  · Per-source Firecrawl Search candidate counts (child C / MESITA-200): link
--    discovery gathers candidates via Firecrawl Search per source (footer scrape
--    is gone). How many results to pull per source is now config, not hardcoded.
--  · Instagram download DEPTH (child D / MESITA-201): the post scrape pulls
--    `depth` posts (1–30); after sorting by likes we KEEP `atlas_gather_instagram_posts`
--    (0–10). Enforce keep ≤ depth. Google stays a single 1-param cap
--    (atlas_gather_google_images) — Google returns photos pre-sorted best→worst.

alter table public.app_settings
  -- Per-source Firecrawl Search candidate counts (S4 gather). 0 disables a source.
  add column if not exists atlas_discover_website_n    smallint not null default 5,
  add column if not exists atlas_discover_instagram_n  smallint not null default 5,
  add column if not exists atlas_discover_facebook_n    smallint not null default 5,
  add column if not exists atlas_discover_opentable_n  smallint not null default 3,
  add column if not exists atlas_discover_ubereats_n   smallint not null default 2,
  -- Instagram download depth (posts pulled before the likes-sort + keep).
  add column if not exists atlas_gather_instagram_depth smallint not null default 30;

do $$
declare
  col text;
begin
  -- Per-source candidate counts: 0–10 (Firecrawl Search page size ceiling).
  foreach col in array array[
    'atlas_discover_website_n', 'atlas_discover_instagram_n',
    'atlas_discover_facebook_n', 'atlas_discover_opentable_n',
    'atlas_discover_ubereats_n'
  ]
  loop
    if not exists (select 1 from pg_constraint where conname = col || '_range') then
      execute format(
        'alter table public.app_settings add constraint %I check (%I between 0 and 10)',
        col || '_range', col
      );
    end if;
  end loop;

  -- Instagram download depth: 1–30.
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_gather_instagram_depth_range') then
    alter table public.app_settings add constraint app_settings_atlas_gather_instagram_depth_range
      check (atlas_gather_instagram_depth between 1 and 30);
  end if;

  -- Keep ≤ depth: we can never keep more posts than we downloaded.
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_ig_keep_le_depth') then
    alter table public.app_settings add constraint app_settings_atlas_ig_keep_le_depth
      check (atlas_gather_instagram_posts <= atlas_gather_instagram_depth);
  end if;
end$$;

notify pgrst, 'reload schema';
