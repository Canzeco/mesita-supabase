-- Sourcing config — add the SEARCH channels for business + consumer.
--
-- The first cut (20260708120000) shipped five channels. This splits sourcing into
-- a full search × add matrix per actor, because the SEARCH filter also governs
-- visibility of Google places NOT yet in Mesita (surfaced in the searchbar as
-- "add this place" candidates) — reject a place in a search channel and it never
-- appears at all, even as a suggestion. `add` channels govern actual onboarding.
--
-- Channels are now (search before add, actor by actor):
--   admin_search · admin_add · business_search · business_add ·
--   consumer_search · consumer_add · memo_search
--
-- consumer_search is a touch looser than consumer_add (see 50+ reviews, but
-- onboarding still needs 100+) — you can discover a spot before it clears the
-- onboarding bar. See the admin catalog (sourcing-config/catalog.ts) for the
-- family → Google type mapping and the per-channel semantics.

-- 1. New column default for fresh projects: the full 7-channel policy.
alter table public.app_settings
  alter column sourcing_config set default $sourcing$
{
  "admin_search":    { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","wellness_spa","experiences","culture_arts"], "minRating": 0,   "minReviews": 0   },
  "admin_add":       { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","wellness_spa","experiences","culture_arts"], "minRating": 0,   "minReviews": 0   },
  "business_search": { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","wellness_spa","experiences","culture_arts"], "minRating": 0,   "minReviews": 0   },
  "business_add":    { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","wellness_spa","experiences","culture_arts"], "minRating": 0,   "minReviews": 0   },
  "consumer_search": { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","experiences","culture_arts","wellness_spa"], "minRating": 3.5, "minReviews": 50  },
  "consumer_add":    { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","experiences","culture_arts","wellness_spa"], "minRating": 3.5, "minReviews": 100 },
  "memo_search":     { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","experiences","culture_arts","wellness_spa"], "minRating": 4.0, "minReviews": 50  }
}
$sourcing$::jsonb;

-- 2. Backfill the existing singleton with the two new SEARCH channels, without
--    clobbering any operator edits already made to the five existing channels.
--    coalesce keeps a channel that somehow already exists; `||` only adds keys.
update public.app_settings
set sourcing_config = sourcing_config
  || jsonb_build_object(
       'business_search',
       coalesce(
         sourcing_config -> 'business_search',
         '{"enabled":true,"families":["restaurants","bars_nightlife","cafes_bakeries","wellness_spa","experiences","culture_arts"],"minRating":0,"minReviews":0}'::jsonb
       ),
       'consumer_search',
       coalesce(
         sourcing_config -> 'consumer_search',
         '{"enabled":true,"families":["restaurants","bars_nightlife","cafes_bakeries","experiences","culture_arts","wellness_spa"],"minRating":3.5,"minReviews":50}'::jsonb
       )
     )
where id = 1;
