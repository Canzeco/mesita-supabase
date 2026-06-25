-- 20260625140000_venue_yelp_url.sql
-- ADEA adds Yelp as a niche-social Link field (T3). Yelp was the one ADEA link
-- node with no landing column — tripadvisor_url / youtube_url / tiktok_url
-- already exist (0003 / 0007). Add yelp_url so atlas-enrich-profile can persist
-- a resolved Yelp listing URL. Nullable plain text, matching the other link
-- columns; the venues-update path enforces the https:// shape before write.

alter table public.venues
  add column if not exists yelp_url text;

notify pgrst, 'reload schema';
