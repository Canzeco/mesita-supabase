-- MESITA-76: persist consumer profile visibility server-side.
-- The Settings → Social toggles ("Public profile" + nested "Show saved
-- places" / "Show visits & reviews") previously lived only in the device's
-- localStorage. Three boolean flags on consumers make them account-level;
-- defaults mirror the client defaults (everything visible).

alter table public.consumers
  add column if not exists profile_public boolean not null default true,
  add column if not exists profile_show_saves boolean not null default true,
  add column if not exists profile_show_visits boolean not null default true;
