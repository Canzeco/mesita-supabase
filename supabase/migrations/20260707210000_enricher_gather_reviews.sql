-- Enricher: admin-selectable Google review count — how many reviews the S2/S4
-- Apify Google Maps scrape pulls (feeds synthesis grounding). Was hardcoded to
-- maxReviews:100; default stays 100 so behavior is unchanged. Fewer reviews =
-- cheaper + faster (reviews bill ~$0.50/100 on the compass actor).
alter table public.app_settings
  add column if not exists atlas_gather_reviews int not null default 100;

alter table public.app_settings
  drop constraint if exists app_settings_atlas_gather_reviews_check;
alter table public.app_settings
  add constraint app_settings_atlas_gather_reviews_check
  check (atlas_gather_reviews between 0 and 100);
