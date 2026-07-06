-- MESITA-112 — Perf advisor cleanup on client-facing RLS policies.
--
-- Two Supabase performance-advisor warning classes on the app tables:
--   (1) auth_rls_initplan (15 policies): a bare auth.uid() in the USING/CHECK
--       expression is re-evaluated once PER ROW. Wrapping it in a scalar
--       subselect — (select auth.uid()) — makes Postgres treat it as an
--       initplan and evaluate it ONCE per query.
--   (2) multiple_permissive_policies (account_invites, project_roles,
--       staff_invites): each had TWO overlapping permissive SELECT policies for
--       the same roles, so both run on every query. Merged into one policy each
--       with an OR of the two conditions.
--
-- Semantically identical: exactly the same rows are visible to exactly the same
-- callers, just evaluated more cheaply. RLS stays ENABLED on every table.
-- Client access to these tables is EF-only (service-role, which bypasses RLS),
-- confirmed by a grep audit of mesita-web-{consumer,business,admin} — no direct
-- .from()/.rpc()/realtime on any of them — so no client path changes behavior.

-- ── accounts ──────────────────────────────────────────────────────────────────
drop policy if exists "businesses_select_self" on public.accounts;
create policy "businesses_select_self" on public.accounts
  for select to public using (id = (select auth.uid()));
drop policy if exists "businesses_update_self" on public.accounts;
create policy "businesses_update_self" on public.accounts
  for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- ── consumers ─────────────────────────────────────────────────────────────────
drop policy if exists "consumers_select_self" on public.consumers;
create policy "consumers_select_self" on public.consumers
  for select to public using (id = (select auth.uid()));
drop policy if exists "consumers_update_self" on public.consumers;
create policy "consumers_update_self" on public.consumers
  for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- ── consumer_subscriptions ────────────────────────────────────────────────────
drop policy if exists "consumer_subscriptions_select_own" on public.consumer_subscriptions;
create policy "consumer_subscriptions_select_own" on public.consumer_subscriptions
  for select to public using ((select auth.uid()) = consumer_id);

-- ── coupons ───────────────────────────────────────────────────────────────────
drop policy if exists "coupons_select_own" on public.coupons;
create policy "coupons_select_own" on public.coupons
  for select to public using ((select auth.uid()) = consumer_id);

-- ── project_members ───────────────────────────────────────────────────────────
drop policy if exists "project_members_select_self" on public.project_members;
create policy "project_members_select_self" on public.project_members
  for select to authenticated using (business_id = (select auth.uid()));

-- ── project_subscriptions ─────────────────────────────────────────────────────
drop policy if exists "project_subscriptions_select_member" on public.project_subscriptions;
create policy "project_subscriptions_select_member" on public.project_subscriptions
  for select to public using (exists (
    select 1 from public.project_members m
    where m.project_id = project_subscriptions.project_id
      and m.business_id = (select auth.uid())));

-- ── reservations ──────────────────────────────────────────────────────────────
drop policy if exists "reservations_select_own" on public.reservations;
create policy "reservations_select_own" on public.reservations
  for select to public using ((select auth.uid()) = consumer_id);

-- ── saved_places ──────────────────────────────────────────────────────────────
drop policy if exists "saved_places_select_own" on public.saved_places;
create policy "saved_places_select_own" on public.saved_places
  for select to public using ((select auth.uid()) = consumer_id);

-- ── ticket_reviews ────────────────────────────────────────────────────────────
drop policy if exists "ticket_reviews_select_own" on public.ticket_reviews;
create policy "ticket_reviews_select_own" on public.ticket_reviews
  for select to authenticated using (consumer_id = (select auth.uid()));

-- ── tickets ───────────────────────────────────────────────────────────────────
drop policy if exists "tickets_select_own_consumer" on public.tickets;
create policy "tickets_select_own_consumer" on public.tickets
  for select to authenticated using (consumer_id = (select auth.uid()));

-- ── account_invites — consolidate two SELECT policies into one ────────────────
drop policy if exists "account_invites_select_by_project_member" on public.account_invites;
drop policy if exists "business_invites_select_creator" on public.account_invites;
create policy "account_invites_select_member_or_creator" on public.account_invites
  for select to public using (
    (created_by = (select auth.uid()))
    or exists (
      select 1 from public.project_members vm
      where vm.project_id = account_invites.project_id
        and vm.business_id = (select auth.uid())));

-- ── project_roles — consolidate two SELECT policies into one ──────────────────
drop policy if exists "project_roles_select_by_project_member" on public.project_roles;
drop policy if exists "project_roles_select_own" on public.project_roles;
create policy "project_roles_select_member_or_own" on public.project_roles
  for select to public using (
    (user_id = (select auth.uid()))
    or exists (
      select 1 from public.project_members vm
      where vm.project_id = project_roles.project_id
        and vm.business_id = (select auth.uid())));

-- ── staff_invites — consolidate two SELECT policies into one ──────────────────
drop policy if exists "staff_invites_select_by_project_member" on public.staff_invites;
drop policy if exists "staff_invites_select_creator" on public.staff_invites;
create policy "staff_invites_select_member_or_creator" on public.staff_invites
  for select to public using (
    (created_by = (select auth.uid()))
    or exists (
      select 1 from public.project_members vm
      where vm.project_id = staff_invites.project_id
        and vm.business_id = (select auth.uid())));
