-- ADEA: a separate model tier for image vision.
--
-- The admin "Models" card selects a model for text (atlas_synthesis_quality)
-- and now for images too. Add atlas_vision_quality with the same
-- economy/standard/high tiers; default 'economy' matches today's hardcoded
-- gpt-4o-mini vision, so behaviour is unchanged until an admin raises it.
--
-- NOTE: the enricher's vision model is still wired to a constant; it starts
-- consuming this column in the ADEA enricher pass. This migration only adds
-- the stored preference + its admin read/write path.

alter table public.app_settings
  add column if not exists atlas_vision_quality text not null default 'economy';

alter table public.app_settings
  drop constraint if exists app_settings_atlas_vision_quality_check;

alter table public.app_settings
  add constraint app_settings_atlas_vision_quality_check
  check (atlas_vision_quality in ('economy', 'standard', 'high'));

notify pgrst, 'reload schema';
