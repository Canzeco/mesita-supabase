-- Sourcing config — which Google places are eligible to enter Mesita, per channel.
--
-- Backs the admin console's Sourcing Config page (admin.mesita.ai/sourcing-config)
-- via admin-web-get-sourcing-config / admin-web-update-sourcing-config. Mesita
-- onboards places sourced from Google Places (New); this policy decides, per
-- SOURCING CHANNEL, which place FAMILIES are eligible and the Google quality bar
-- (min rating + min review count). A place is only eligible for a channel when
-- its Google primary type falls in one of that channel's enabled families AND it
-- clears the channel's rating/review floors.
--
-- Convention mirrors the Memo/Enricher knobs: config lives on the single-row
-- public.app_settings (id = 1, RLS-enabled, no policies → EF-only). One jsonb
-- column keyed by channel; adding it to the existing row resolves to the default
-- policy below with no data migration.
--
-- Channels (keys are the contract shared with the admin catalog + the EFs):
--   admin_add     — operator adds a place from the admin console (most permissive).
--   admin_search  — what surfaces in the admin discovery searchbar (discover-places).
--   business_add  — a business owner claims / adds their own venue.
--   consumer_add  — a consumer suggests / adds a place (quality-gated).
--   memo_search   — what Memo (the consumer concierge) may surface / recommend.
--
-- Family keys (mapped to Google primary types in code — see the admin catalog):
--   restaurants · bars_nightlife · cafes_bakeries · wellness_spa · experiences · culture_arts
--
-- Per-channel shape: { enabled: bool, families: text[], minRating: number, minReviews: int }.
-- minRating / minReviews of 0 mean "no floor". The defaults encode the launch
-- policy: operators are unrestricted; businesses may add any eligible family with
-- no review floor (you own your venue even if it's new); consumers and Memo are
-- gated to well-reviewed places to keep junk and personal listings out.
--
-- Enforcement rollout: the policy is AUTHORED here now. admin_search's floors are
-- already honoured by admin-web-discover-places (minRating/minUserRatingCount);
-- the remaining channels get wired to read this config as each add-path is
-- updated. Editing the page never breaks a channel that hasn't been wired yet.

alter table public.app_settings
  add column if not exists sourcing_config jsonb not null default $sourcing$
{
  "admin_add":    { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","wellness_spa","experiences","culture_arts"], "minRating": 0,   "minReviews": 0   },
  "admin_search": { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","wellness_spa","experiences","culture_arts"], "minRating": 0,   "minReviews": 0   },
  "business_add": { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","wellness_spa","experiences","culture_arts"], "minRating": 0,   "minReviews": 0   },
  "consumer_add": { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","experiences","culture_arts","wellness_spa"], "minRating": 3.5, "minReviews": 100 },
  "memo_search":  { "enabled": true, "families": ["restaurants","bars_nightlife","cafes_bakeries","experiences","culture_arts","wellness_spa"], "minRating": 4.0, "minReviews": 50  }
}
$sourcing$::jsonb;
