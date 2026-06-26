-- Add the "Undefined" fallback category.
--
-- The async create path seeds places.category='undefined' (no category inference
-- at create); the n8n Enricher then resolves the real category at S5, but writes
-- 'undefined' when inference is low-confidence or fails. An "Undefined" category
-- MUST therefore exist in the catalog so category (and the category_label sync
-- trigger) always resolves to a real row.
--
-- Idempotent. venue_categories is config — admin_reset_database() does NOT
-- truncate it (it only re-seeds the canonical 100 via seed_venue_categories()),
-- so this row, once inserted, persists across resets. sort_order 999 sinks it to
-- the end of any ordered picker.

insert into public.venue_categories (slug, label, section, sort_order)
values ('undefined', '❓ Undefined', 'Food & Nightlife', 999)
on conflict (slug) do update set
  label      = excluded.label,
  section    = excluded.section,
  sort_order = excluded.sort_order;

notify pgrst, 'reload schema';
