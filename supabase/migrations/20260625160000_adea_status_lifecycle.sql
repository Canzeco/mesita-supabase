-- ADEA enrichment lifecycle (Phase 2a)
--
-- A venue enters life as 'pending' (seeded by business-create-unit), Atlas
-- flips it 'running' → 'ready'/'failed' as atlas-enrich-place progresses, and
-- the public select RLS policy only exposes 'ready' venues to consumers.
-- Owners read via the service role, so they still see their own pending rows.

-- Lifecycle states for the ADEA enrichment pipeline.
create type public.adea_status as enum ('pending', 'running', 'ready', 'failed');

-- New column; fresh venues default to 'pending' (set explicitly at create too).
alter table public.venues
  add column adea_status public.adea_status not null default 'pending';

-- Existing rows predate the lifecycle and are already enriched/live → ready.
update public.venues set adea_status = 'ready';

-- Tighten the PUBLIC select policy: reproduce venues_select_public_visible
-- exactly (same name, roles, command, status gate) but also require the venue
-- to have finished enriching. Consumers therefore never see pending/running/
-- failed venues; owners read via the service role and bypass RLS entirely.
drop policy if exists "venues_select_public_visible" on public.venues;
create policy "venues_select_public_visible"
  on public.venues
  for select
  to anon, authenticated
  using (status in ('active', 'lead') and adea_status = 'ready');
