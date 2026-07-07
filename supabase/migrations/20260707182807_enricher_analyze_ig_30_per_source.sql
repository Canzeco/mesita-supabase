-- Enricher image funnel — per-source lock (analyze ≤ that source's keep).
--
-- The funnel used to enforce collection ≥ analysis ≥ selection by SUM, which
-- let one source's slack mask another's overflow — e.g. analyze 15 Instagram
-- posts when only 10 were kept, as long as Google made up the collection total.
-- The rule is now per source (enforced in admin-web-update-atlas-config):
--   IG keep ≤ IG depth · analyze ≤ keep per source · save ≤ analyzed total.
--
-- Instagram keep ranges 1–30 (0059) and keep ≤ depth (20260707000000), so
-- Instagram analyze must be allowed to match it: widen its ceiling 20 → 30.
-- The DB keeps only the outer range guard (matching how the funnel has always
-- split — keep ≤ depth is the sole cross-column CHECK); the per-source chain
-- lives in the Edge Function.

alter table public.app_settings
  drop constraint if exists app_settings_atlas_analyze_instagram_images_range;

alter table public.app_settings
  add constraint app_settings_atlas_analyze_instagram_images_range
    check (atlas_analyze_instagram_images between 0 and 30);

-- Heal any row the old sum-only lock left in a per-source-invalid state:
-- analyze must not exceed that source's keep, and save must not exceed the
-- analyzed total. Order matters — clamp analyze first, then save.
update public.app_settings
  set atlas_analyze_instagram_images = atlas_gather_instagram_posts
  where atlas_analyze_instagram_images > atlas_gather_instagram_posts;

update public.app_settings
  set atlas_analyze_google_images = atlas_gather_google_images
  where atlas_analyze_google_images > atlas_gather_google_images;

update public.app_settings
  set atlas_save_total_images =
    least(atlas_save_total_images,
          atlas_analyze_google_images + atlas_analyze_instagram_images)
  where atlas_save_total_images
        > atlas_analyze_google_images + atlas_analyze_instagram_images;

notify pgrst, 'reload schema';
