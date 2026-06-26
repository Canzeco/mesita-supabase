-- R0 (nomenclature): rename the legacy venues_* / manager_invites_* constraints
-- and indexes left behind by the venues→units/places split. Metadata-only —
-- no data movement, no EF/client impact (no EF references these names). Renaming
-- a PK/unique CONSTRAINT also renames its backing index, so the two
-- constraint-backed indexes are handled by the constraint renames below; only the
-- two plain indexes need an explicit ALTER INDEX.

-- places: primary key + unique (backing indexes follow the constraint rename)
alter table public.places rename constraint venues_pkey to places_pkey;
alter table public.places rename constraint venues_google_place_id_key to places_google_place_id_key;

-- places: 14 check constraints
alter table public.places rename constraint venues_facebook_followers_check to places_facebook_followers_check;
alter table public.places rename constraint venues_facebook_rating_check to places_facebook_rating_check;
alter table public.places rename constraint venues_google_review_count_check to places_google_review_count_check;
alter table public.places rename constraint venues_google_stars_overall_check to places_google_stars_overall_check;
alter table public.places rename constraint venues_google_visitor_count_check to places_google_visitor_count_check;
alter table public.places rename constraint venues_instagram_followers_count_check to places_instagram_followers_count_check;
alter table public.places rename constraint venues_mesita_review_count_check to places_mesita_review_count_check;
alter table public.places rename constraint venues_mesita_stars_ambience_check to places_mesita_stars_ambience_check;
alter table public.places rename constraint venues_mesita_stars_food_check to places_mesita_stars_food_check;
alter table public.places rename constraint venues_mesita_stars_overall_check to places_mesita_stars_overall_check;
alter table public.places rename constraint venues_mesita_stars_service_check to places_mesita_stars_service_check;
alter table public.places rename constraint venues_mesita_stars_value_check to places_mesita_stars_value_check;
alter table public.places rename constraint venues_mesita_visitor_count_check to places_mesita_visitor_count_check;
alter table public.places rename constraint venues_price_level_check to places_price_level_check;

-- places: 2 plain indexes
alter index public.venues_country_idx rename to places_country_idx;
alter index public.venues_embedding_hnsw rename to places_embedding_hnsw;

-- business_invites: 3 FK constraints still named manager_invites_*
alter table public.business_invites rename constraint manager_invites_venue_id_fkey to business_invites_venue_id_fkey;
alter table public.business_invites rename constraint manager_invites_created_by_fkey to business_invites_created_by_fkey;
alter table public.business_invites rename constraint manager_invites_claimed_by_fkey to business_invites_claimed_by_fkey;

notify pgrst, 'reload schema';
