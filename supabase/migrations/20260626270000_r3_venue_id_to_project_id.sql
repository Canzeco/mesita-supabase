-- R3 (nomenclature): venue_id → project_id columns + FK/unique/index/constraint
-- renames + rebuild the 3 venue_id policies and the 2 saved_places coupon trigger
-- fns (R2 left their bodies on venue_id). Depends on R2 (tables already renamed to
-- their place_*/project_* names). Forward-only; never edit applied migrations.

-- ── 1. column + FK + unique-constraint + pkey renames ───────────────────────
alter table public.place_media_assets rename column venue_id to project_id;
alter table public.place_media_assets rename constraint venue_media_assets_venue_id_fkey to place_media_assets_project_id_fkey;
alter table public.place_media_assets rename constraint venue_media_assets_venue_id_source_url_key to place_media_assets_project_id_source_url_key;
alter table public.place_media_assets rename constraint venue_media_assets_pkey to place_media_assets_pkey;
alter table public.project_members rename column venue_id to project_id;
alter table public.project_members rename constraint venue_members_venue_id_fkey to project_members_project_id_fkey;
alter table public.project_members rename constraint venue_members_venue_id_business_id_key to project_members_project_id_business_id_key;
alter table public.project_members rename constraint venue_members_pkey to project_members_pkey;
alter table public.project_roles rename column venue_id to project_id;
alter table public.project_roles rename constraint venue_roles_venue_id_fkey to project_roles_project_id_fkey;
alter table public.project_roles rename constraint venue_roles_pkey to project_roles_pkey;
alter table public.project_verifications rename column venue_id to project_id;
alter table public.project_verifications rename constraint venue_verifications_venue_id_fkey to project_verifications_project_id_fkey;
-- one_pending_per_requester is a partial UNIQUE INDEX (not a table constraint) → ALTER INDEX.
alter index public.venue_verifications_one_pending_per_requester rename to project_verifications_one_pending_per_requester;
alter table public.project_verifications rename constraint venue_verifications_pkey to project_verifications_pkey;
alter table public.saved_places rename column venue_id to project_id;
alter table public.saved_places rename constraint saved_venues_venue_id_fkey to saved_places_project_id_fkey;
alter table public.saved_places rename constraint saved_venues_consumer_id_venue_id_key to saved_places_consumer_id_project_id_key;
alter table public.saved_places rename constraint saved_venues_pkey to saved_places_pkey;
alter table public.account_invites rename column venue_id to project_id;
alter table public.account_invites rename constraint business_invites_venue_id_fkey to account_invites_project_id_fkey;
alter table public.coupons rename column venue_id to project_id;
alter table public.coupons rename column saved_venue_id to saved_place_id;
alter table public.coupons rename constraint coupons_venue_id_fkey to coupons_project_id_fkey;
alter table public.coupons rename constraint coupons_saved_venue_id_fkey to coupons_saved_place_id_fkey;
alter table public.reservations rename column venue_id to project_id;
alter table public.reservations rename constraint reservations_venue_id_fkey to reservations_project_id_fkey;
alter table public.staff_invites rename column venue_id to project_id;
alter table public.staff_invites rename constraint staff_invites_venue_id_fkey to staff_invites_project_id_fkey;
-- one_pending_phone_per_venue is a partial UNIQUE INDEX (not a table constraint) → ALTER INDEX.
alter index public.staff_invites_one_pending_phone_per_venue rename to staff_invites_one_pending_phone_per_project;
alter table public.staff_whatsapp_sessions rename column venue_id to project_id;
alter table public.staff_whatsapp_sessions rename constraint staff_whatsapp_sessions_venue_id_fkey to staff_whatsapp_sessions_project_id_fkey;
alter table public.ticket_reviews rename column venue_id to project_id;
alter table public.ticket_reviews rename constraint ticket_reviews_venue_id_fkey to ticket_reviews_project_id_fkey;
alter table public.tickets rename column venue_id to project_id;
alter table public.tickets rename constraint tickets_venue_id_fkey to tickets_project_id_fkey;

-- ── 2. plain index renames (names embedded venue/table) ─────────────────────
alter index if exists public.business_invites_venue_idx rename to account_invites_project_idx;
alter index if exists public.ticket_reviews_venue_idx rename to ticket_reviews_project_idx;
alter index if exists public.venue_members_venue_idx rename to project_members_project_idx;
alter index if exists public.venue_members_business_idx rename to project_members_business_idx;
alter index if exists public.reservations_venue_idx rename to reservations_project_idx;
alter index if exists public.coupons_venue_idx rename to coupons_project_idx;
alter index if exists public.coupons_one_active_per_venue rename to coupons_one_active_per_project;
alter index if exists public.saved_venues_venue_idx rename to saved_places_project_idx;
alter index if exists public.saved_venues_consumer_idx rename to saved_places_consumer_idx;
alter index if exists public.staff_invites_venue_idx rename to staff_invites_project_idx;
alter index if exists public.venue_roles_venue_idx rename to project_roles_project_idx;
alter index if exists public.venue_roles_user_idx rename to project_roles_user_idx;
alter index if exists public.tickets_venue_idx rename to tickets_project_idx;
alter index if exists public.venue_verifications_venue_idx rename to project_verifications_project_idx;
alter index if exists public.venue_verifications_requester_idx rename to project_verifications_requester_idx;
alter index if exists public.venue_verifications_pending_idx rename to project_verifications_pending_idx;
alter index if exists public.venue_media_assets_venue_id_idx rename to place_media_assets_project_id_idx;
alter index if exists public.venue_media_assets_status_idx rename to place_media_assets_status_idx;

-- ── 2b. residual venue_* names on the R2-renamed tables ──────────────────────
-- R2 renamed the TABLES (venue_categories→place_categories, venue_tags→place_tags,
-- venue_media_assets→place_media_assets, venue_members→project_members,
-- venue_roles→project_roles, venue_verifications→project_verifications,
-- saved_venues→saved_places) but their PK / non-venue_id FK / CHECK constraints,
-- two policies, and one trigger kept the old venue_* names. Rename them to match
-- the new table prefix so NO public object name still contains 'venue'.
-- (A PK/unique constraint rename also renames its backing index.)

-- PK constraints (rename their backing index too)
alter table public.place_categories rename constraint venue_categories_pkey to place_categories_pkey;
alter table public.place_tags       rename constraint venue_tags_pkey       to place_tags_pkey;

-- CHECK constraints
alter table public.place_categories       rename constraint venue_categories_section_check        to place_categories_section_check;
alter table public.place_media_assets     rename constraint venue_media_assets_source_check        to place_media_assets_source_check;
alter table public.place_media_assets     rename constraint venue_media_assets_status_check        to place_media_assets_status_check;
alter table public.place_tags             rename constraint venue_tags_facet_check                 to place_tags_facet_check;
alter table public.place_tags             rename constraint venue_tags_section_check               to place_tags_section_check;
alter table public.project_verifications  rename constraint venue_verifications_decided_via_check  to project_verifications_decided_via_check;
alter table public.project_verifications  rename constraint venue_verifications_requester_email_check to project_verifications_requester_email_check;
alter table public.staff_whatsapp_sessions rename constraint staff_whatsapp_sessions_venue_when_active to staff_whatsapp_sessions_project_when_active;

-- FK constraints that are NOT on the venue_id column (so §1 didn't catch them)
alter table public.project_members        rename constraint venue_members_business_id_fkey   to project_members_business_id_fkey;
alter table public.project_roles          rename constraint venue_roles_invited_by_fkey      to project_roles_invited_by_fkey;
alter table public.project_roles          rename constraint venue_roles_user_id_fkey         to project_roles_user_id_fkey;
alter table public.project_verifications  rename constraint venue_verifications_decided_by_fkey   to project_verifications_decided_by_fkey;
alter table public.project_verifications  rename constraint venue_verifications_requester_id_fkey to project_verifications_requester_id_fkey;
alter table public.saved_places           rename constraint saved_venues_consumer_id_fkey    to saved_places_consumer_id_fkey;

-- leftover venue_* policies on renamed tables (the *_by_venue_member ones on
-- project_roles / staff_invites / account_invites are rebuilt in §4 below)
alter policy venue_categories_select_all on public.place_categories rename to place_categories_select_all;
alter policy venue_tags_select_all       on public.place_tags       rename to place_tags_select_all;
alter policy venue_members_select_self   on public.project_members  rename to project_members_select_self;
alter policy venue_roles_select_own      on public.project_roles    rename to project_roles_select_own;
alter policy saved_venues_select_own     on public.saved_places     rename to saved_places_select_own;

-- leftover venue_* trigger name on the renamed media-assets table
alter trigger venue_media_assets_set_updated_at on public.place_media_assets
  rename to place_media_assets_set_updated_at;

-- ── 3. rebuild the saved_places coupon trigger fns on project_id/saved_place_id ──
create or replace function public.tg_saved_places_issue_coupon()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare v record;
begin
  select listing_type, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, currency
    into v from public.projects where id = new.project_id;
  if not found or v.listing_type <> 'partner' then return new; end if;
  insert into public.coupons (
    consumer_id, project_id, saved_place_id,
    welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, cap_cents, currency
  ) values (
    new.consumer_id, new.project_id, new.id,
    v.welcome_free_rate, v.welcome_premium_rate, v.free_rate, v.premium_rate, 0, coalesce(v.currency,'MXN')
  ) on conflict (consumer_id, project_id) where status = 'active' do nothing;
  return new;
end$function$;

create or replace function public.tg_saved_places_cancel_coupon()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  update public.coupons set status='cancelled', cancelled_at=now()
   where consumer_id = old.consumer_id and project_id = old.project_id and status='active';
  return old;
end$function$;

-- ── 4. rebuild the 3 policies that referenced venue_id (now project_id, project_members) ──
-- NOTE: R2 renamed the TABLES but not these policy names, so the existing policy on
-- project_roles is still named venue_roles_select_by_venue_member (drop that exact
-- name, not project_roles_*). staff_invites / account_invites keep their original
-- table-prefixed policy names (staff_invites / business_invites).
drop policy if exists venue_roles_select_by_venue_member on public.project_roles;
create policy project_roles_select_by_project_member on public.project_roles for select using (
  exists (select 1 from public.project_members vm where vm.project_id = project_roles.project_id and vm.business_id = (select auth.uid())));

drop policy if exists staff_invites_select_by_venue_member on public.staff_invites;
create policy staff_invites_select_by_project_member on public.staff_invites for select using (
  exists (select 1 from public.project_members vm where vm.project_id = staff_invites.project_id and vm.business_id = (select auth.uid())));

drop policy if exists business_invites_select_by_venue_member on public.account_invites;
create policy account_invites_select_by_project_member on public.account_invites for select using (
  exists (select 1 from public.project_members vm where vm.project_id = account_invites.project_id and vm.business_id = (select auth.uid())));

notify pgrst, 'reload schema';
