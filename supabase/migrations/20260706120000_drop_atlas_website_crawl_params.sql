-- Drop the website-crawl enrichment knobs from app_settings.
--
-- The Enricher no longer scrapes the website body (S4 website CONTENT crawl was
-- retired): description / tags / category are built from the Google spine +
-- reviews + the Perplexity SERP blurb (+ IG bio), and menus/website images are
-- no longer gathered. S3 channel discovery still Firecrawl-scrapes the footer
-- for social/reservation links — that path keeps no app_settings knob.
--
-- These three columns are now unread by every Edge Function. Dropping them also
-- drops their range check constraints (cascade with the column).

alter table public.app_settings
  drop column if exists atlas_website_crawl_max_pages,
  drop column if exists atlas_gather_website_images,
  drop column if exists atlas_analyze_website_images;
