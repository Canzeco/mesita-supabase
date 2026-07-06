-- Security hardening (advisor lints 0028/0029): revoke anon/authenticated
-- EXECUTE on SECURITY DEFINER functions that must not be callable through the
-- public PostgREST RPC surface.
--
-- run_place_enrichment_stages() is the enricher cron dispatcher — an anonymous
-- POST to /rest/v1/rpc/run_place_enrichment_stages could trigger the whole
-- pipeline (firing stage EFs → external API spend + Vault service-role key).
-- Its sibling run_scheduled_project_creations() was already locked; this one
-- had direct anon/authenticated grants that missed the lockdown.
--
-- projects_view_{insert,update,delete}() are INSTEAD-OF trigger fns for the
-- updatable projects_view. (The direct-role revoke here is a no-op for them —
-- they inherit EXECUTE via PUBLIC; that is stripped in the next migration.)
--
-- Safe: pg_cron runs its job as the owner (superuser, bypasses EXECUTE checks)
-- and INSTEAD-OF triggers fire regardless of the caller's EXECUTE privilege.
-- Clients never call these via RPC (DB access is EF/service-role only).

revoke execute on function public.run_place_enrichment_stages() from anon, authenticated;
revoke execute on function public.projects_view_insert() from anon, authenticated;
revoke execute on function public.projects_view_update() from anon, authenticated;
revoke execute on function public.projects_view_delete() from anon, authenticated;
