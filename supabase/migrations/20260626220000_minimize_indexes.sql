-- Phase 3 (minimize indexes): drop 3 structurally-redundant indexes.
--
-- Each is fully covered by another index, so uniqueness/lookup behavior is
-- unchanged:
--   • business_invites_token_idx        — plain btree duplicating UNIQUE business_invites_token_key
--   • staff_invites_token_idx           — plain btree duplicating UNIQUE staff_invites_token_key
--   • consumer_subscriptions_consumer_idx — left-prefix already served by the
--                                           partial-unique consumer_subscriptions_one_live
-- (Legacy venues_* index RENAMEs on `places` are deferred to the rename sweep R0.)

drop index if exists public.business_invites_token_idx;
drop index if exists public.staff_invites_token_idx;
drop index if exists public.consumer_subscriptions_consumer_idx;
