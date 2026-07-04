-- Per-step Enricher progress events. Written by enricher-report-step (the n8n
-- Enricher fires it as a leaf branch after each pipeline step, service-role
-- only); read by admin-list-notifications (atlas.enrichment_step feed items).
-- No client RLS policies — the table is a service-role-only surface.
--
-- Purely additive. admin_reset_database() needs no change: its
-- `truncate … restart identity cascade` already wipes this table through the
-- places FK cascade on every reset.

create table public.place_enrichment_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.places(id) on delete cascade,
  step text not null check (step ~ '^S[0-9]$'),
  step_name text not null,
  status text not null default 'completed'
    check (status in ('started', 'completed', 'failed', 'skipped')),
  detail text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.place_enrichment_events is
  'n8n Enricher per-step progress events (service-role only; feeds the admin console notifications).';

create index place_enrichment_events_project_idx
  on public.place_enrichment_events (project_id, created_at desc);
create index place_enrichment_events_created_idx
  on public.place_enrichment_events (created_at desc);

alter table public.place_enrichment_events enable row level security;
