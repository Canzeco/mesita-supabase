-- Atomic super-admin revoke.
--
-- The admin-revoke-admin Edge Function used to read the allowlist count and
-- then DELETE in two separate statements. Two concurrent revokes of the last
-- two *distinct* admins could both observe count = 2, both pass the
-- "more than one admin remains" check, and empty the allowlist (a recoverable
-- but real lockout). This security-definer function serializes revokes behind
-- a transaction-scoped advisory lock and enforces the invariant in one place,
-- mirroring public.admin_reset_database. The EF still owns the caller's
-- super_admin gate and the no-self-lockout guard.

create or replace function public.admin_revoke_admin(p_email text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_removed integer;
  v_count integer;
begin
  -- Serialize all revokes so the "never empty the allowlist" check can't race.
  perform pg_advisory_xact_lock(hashtext('public.super_admins:revoke'));

  select count(*) into v_count from public.super_admins;
  if v_count <= 1 then
    raise exception 'last_admin'
      using errcode = 'P0001',
            hint = 'Cannot remove the last remaining admin.';
  end if;

  delete from public.super_admins where email = p_email;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

revoke all on function public.admin_revoke_admin(text) from public;
revoke all on function public.admin_revoke_admin(text) from anon, authenticated;
grant execute on function public.admin_revoke_admin(text) to service_role;
