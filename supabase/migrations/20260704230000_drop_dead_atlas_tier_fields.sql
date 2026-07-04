-- MESITA-41 — drop dead atlas source-tier knobs from app_settings.
--
-- The L0–L5 "source level" tier model is retired: every enrichment step
-- S0–S9 always runs when its real prerequisites hold (API key present +
-- required input exists). The admin UI stopped surfacing/writing
-- sourceTierCeiling/sourceOverrides in MESITA-19, and as of this change no
-- reader remains anywhere:
--   * admin-get-settings no longer returns them
--   * admin-update-atlas-config no longer accepts them
--   * _shared/atlas-config.ts (loadAtlasConfig) never selects them
--
-- Columns were added in 0042_atlas_generation_params.sql; the range check
-- constraint was last touched in 20260625080000_adea_tier_ceiling_max_five.sql.

alter table public.app_settings
  drop constraint if exists app_settings_atlas_source_tier_ceiling_range;

alter table public.app_settings
  drop column if exists atlas_source_tier_ceiling,
  drop column if exists atlas_source_overrides;
