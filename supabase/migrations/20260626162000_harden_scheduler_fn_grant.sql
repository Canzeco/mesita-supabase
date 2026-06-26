-- ============================================================================
-- Harden the scheduler poller's EXECUTE grant.
--
-- 20260626140000_staggered_unit_scheduler revoked EXECUTE from anon+authenticated
-- but NOT from PUBLIC. Postgres grants EXECUTE to PUBLIC by default, so the
-- SECURITY DEFINER poller stayed callable via PostgREST RPC
-- (/rest/v1/rpc/run_scheduled_unit_creations) by the anon + authenticated roles
-- — flagged by the Supabase security linter (lints 0028 / 0029). The function
-- reads a Vault secret and makes an outbound HTTP call, so it must not be
-- reachable by untrusted roles.
--
-- Revoke from PUBLIC. The pg_cron job invokes the function as its owner, which
-- retains EXECUTE regardless, so the 10s poller is unaffected. (The original
-- migration file has also been corrected to revoke from PUBLIC for fresh DBs;
-- this migration fixes the already-applied prod database.)
-- ============================================================================

revoke all on function public.run_scheduled_unit_creations() from public;
