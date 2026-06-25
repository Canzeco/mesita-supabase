-- ADEA re-tiering — the source tier ceiling spans T1–T5 again.
--
-- The Atlas spec was reformatted as ADEA (Link → Contents → Analysis pipeline,
-- tiers T0–T5). The always-on Google/Mesita spine plus the analysis brain is
-- now T0; Google business *contents* split out as T1; niche social links
-- (TripAdvisor/Yelp/TikTok/YouTube) now occupy T4; and the heavy third-party
-- contents (OpenTable/TripAdvisor/SERP Contents) moved from T4 to T5.
--
-- Migration 0047 tightened the ceiling to 1..4 when T4 was the max node. With a
-- real T5 now, restore the original 0042 range so an admin can reach the heavy
-- contents tier. This is a pure constraint relaxation — every stored value
-- (1..4) already satisfies 1..5, so no data backfill is needed.

alter table public.app_settings
  drop constraint if exists app_settings_atlas_source_tier_ceiling_range;

alter table public.app_settings
  add constraint app_settings_atlas_source_tier_ceiling_range
  check (atlas_source_tier_ceiling between 1 and 5);

notify pgrst, 'reload schema';
