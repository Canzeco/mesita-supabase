-- Phase 4 (RLS hardening): lock down over-exposed SECURITY DEFINER functions.
--
-- SEC-1 / SEC-2: these run with owner privileges and were EXECUTE-granted to
-- PUBLIC + anon + authenticated, so any client could call them by RPC —
-- find_user_id_by_phone enables phone→user-id enumeration over auth.users, and
-- the venues_view_* writers bypass the EF-only write path. They are only ever
-- invoked internally (DB triggers for the view fns; service-role EFs for the
-- phone lookup), so revoke from everyone and grant the phone lookup to
-- service_role explicitly.
--
-- (SEC-3 mutable search_path is resolved by dropping tg_set_updated_at in
--  Phase 1. SEC-5 leaked-password protection is a Dashboard toggle, not SQL.
--  SEC-6/7 policy initplan + duplicate-permissive merges are folded into the
--  policy rewrite in the rename sweep R3.)
--
-- NOTE: venues_view_* are renamed to projects_view_* in the rename sweep (R2) —
-- re-apply these REVOKEs to the renamed functions there.

revoke execute on function public.find_user_id_by_phone(text) from public, anon, authenticated;
grant  execute on function public.find_user_id_by_phone(text) to service_role;

revoke execute on function public.venues_view_insert() from public, anon, authenticated;
revoke execute on function public.venues_view_update() from public, anon, authenticated;
revoke execute on function public.venues_view_delete() from public, anon, authenticated;
