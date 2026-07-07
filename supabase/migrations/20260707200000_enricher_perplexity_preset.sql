-- Enricher: admin-selectable Perplexity Agent preset — the "search model" used
-- for S2 (SERP editorial summary) and S3 (channel-link discovery / validate).
-- The Agent API preset bundles a model + step budget + search depth; we default
-- to pro-search (the existing behavior). Options mirror the Perplexity Agent API
-- preset names (docs.perplexity.ai/docs/agent-api/presets).
alter table public.app_settings
  add column if not exists atlas_perplexity_preset text not null default 'pro-search';

alter table public.app_settings
  drop constraint if exists app_settings_atlas_perplexity_preset_check;
alter table public.app_settings
  add constraint app_settings_atlas_perplexity_preset_check
  check (atlas_perplexity_preset in (
    'fast-search', 'pro-search', 'deep-research', 'advanced-deep-research'
  ));
