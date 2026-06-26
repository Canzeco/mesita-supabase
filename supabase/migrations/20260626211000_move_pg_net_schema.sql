-- Phase 2b (security advisor 0014: extension_in_public) — relocate pg_net out of
-- the public schema.
--
-- ⚠️ SCHEDULER-SENSITIVE: run_scheduled_unit_creations() calls net.http_post.
-- pg_net's callable functions live in the `net` schema (unaffected by this move),
-- but verify after applying: re-run the poller once and confirm a row lands in
-- net._http_response. If the scheduler breaks, revert with
--   alter extension pg_net set schema public;
-- This is hardening only (non-blocking) — kept as its own migration so it can be
-- applied and verified in isolation.

alter extension pg_net set schema extensions;
