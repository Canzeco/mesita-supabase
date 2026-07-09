-- MESITA-315 — Client uploads to place-images (admin + business).
--
-- Bucket exists (20260705110000) and is public, but storage.objects has RLS
-- enabled with zero policies — every authenticated INSERT was denied. Enricher
-- writes via service role so it never noticed. Business PlaceMediaModule and
-- admin Place Photos both upload as the signed-in user JWT.
--
-- Path contract (mirrors PlaceMediaModule):
--   business/{project_id}/{timestamp}-{uuid}.{ext}
--
-- Helpers are SECURITY DEFINER because project_members + super_admins are
-- deny-all to authenticated (EF-only tables after MESITA-125).

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.super_admins sa
    where sa.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.is_project_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_members m
    where m.project_id = p_project_id
      and m.business_id = (select auth.uid())
  );
$$;

revoke all on function public.is_super_admin() from public;
revoke all on function public.is_project_member(uuid) from public;
grant execute on function public.is_super_admin() to authenticated;
grant execute on function public.is_project_member(uuid) to authenticated;

-- Public read — bucket is public; gallery URLs must resolve for anon consumers.
drop policy if exists "place_images_public_read" on storage.objects;
create policy "place_images_public_read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'place-images');

-- Members (any role) + super-admins may upload under business/{project_id}/…
drop policy if exists "place_images_member_or_admin_insert" on storage.objects;
create policy "place_images_member_or_admin_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'place-images'
    and (storage.foldername(name))[1] = 'business'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (
      public.is_super_admin()
      or public.is_project_member(((storage.foldername(name))[2])::uuid)
    )
  );

-- Same principals may overwrite/delete their own uploads (optional cleanup).
drop policy if exists "place_images_member_or_admin_update" on storage.objects;
create policy "place_images_member_or_admin_update"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'place-images'
    and (storage.foldername(name))[1] = 'business'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (
      public.is_super_admin()
      or public.is_project_member(((storage.foldername(name))[2])::uuid)
    )
  )
  with check (
    bucket_id = 'place-images'
    and (storage.foldername(name))[1] = 'business'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (
      public.is_super_admin()
      or public.is_project_member(((storage.foldername(name))[2])::uuid)
    )
  );

drop policy if exists "place_images_member_or_admin_delete" on storage.objects;
create policy "place_images_member_or_admin_delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'place-images'
    and (storage.foldername(name))[1] = 'business'
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (
      public.is_super_admin()
      or public.is_project_member(((storage.foldername(name))[2])::uuid)
    )
  );
