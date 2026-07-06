-- MESITA-125 — Remove vestigial client-facing RLS policies (least privilege).
--
-- Follow-up to MESITA-112 (20260706010000), which *optimized* these client
-- policies. This migration *removes* the ones that are provably unused, moving
-- those tables to the same deliberate deny-all EF-only lockdown the repo already
-- runs on other app tables (the intentional `rls_enabled_no_policy` posture).
--
-- ── EF client-access audit (mesita-supabase/functions, 2026-07-06) ──
-- Every Edge Function gets its Supabase client from exactly three builders in
-- `_shared/auth.ts`:
--   • adminClient()          → SERVICE_ROLE key, bypasses RLS   (all writes + reads)
--   • getAuthedUser()/       → anon key + forwarded caller JWT, RLS-scoped
--     getOptionalAuthedUser()  as `authenticated` → returns `userClient`
--   • anonClient()           → anon key, RLS-scoped as anon/`public`
-- There are NO inline createClient() sites in any EF — all four createClient
-- calls live in _shared/auth.ts.
--
-- Grep of every RLS-scoped (non-service-role) data access:
--   • userClient.from(...)  → ONLY `consumers` (SELECT own row) in
--       consumer-web-recommend-swipe + consumer-web-recommend-map.
--   • anonClient.from(...)  → ONLY `projects_view`, `categories`, `tags`
--       (none of the 13 in-scope app tables).
-- Every other .from() on all 13 tables is on the service-role admin client.
--
-- Conclusion: for 12 of the 13 tables NO client path relies on RLS, so their
-- client policies are vestigial. `consumers` is the sole exception — its
-- `consumers_select_self` policy backs a live `authenticated` read — so it is
-- KEPT. Its `consumers_update_self` grant is unused (all profile writes go
-- through service-role EFs) and is dropped.
--
-- RLS stays ENABLED on every table; dropping the policies makes them deny-all
-- to non-service-role. Fully reversible — recreate SQL is captured verbatim
-- from 20260706010000 in the footer of this file (and in MESITA-125).

-- ── accounts ──────────────────────────────────────────────────────────────────
drop policy if exists "businesses_select_self" on public.accounts;
drop policy if exists "businesses_update_self" on public.accounts;

-- ── consumers ─────────────────────────────────────────────────────────────────
-- KEEP consumers_select_self (live authenticated read: recommend-swipe / -map).
drop policy if exists "consumers_update_self" on public.consumers;

-- ── consumer_subscriptions ────────────────────────────────────────────────────
drop policy if exists "consumer_subscriptions_select_own" on public.consumer_subscriptions;

-- ── coupons ───────────────────────────────────────────────────────────────────
drop policy if exists "coupons_select_own" on public.coupons;

-- ── project_members ───────────────────────────────────────────────────────────
drop policy if exists "project_members_select_self" on public.project_members;

-- ── project_subscriptions ─────────────────────────────────────────────────────
drop policy if exists "project_subscriptions_select_member" on public.project_subscriptions;

-- ── reservations ──────────────────────────────────────────────────────────────
drop policy if exists "reservations_select_own" on public.reservations;

-- ── saved_places ──────────────────────────────────────────────────────────────
drop policy if exists "saved_places_select_own" on public.saved_places;

-- ── ticket_reviews ────────────────────────────────────────────────────────────
drop policy if exists "ticket_reviews_select_own" on public.ticket_reviews;

-- ── tickets ───────────────────────────────────────────────────────────────────
drop policy if exists "tickets_select_own_consumer" on public.tickets;

-- ── account_invites ───────────────────────────────────────────────────────────
drop policy if exists "account_invites_select_member_or_creator" on public.account_invites;

-- ── project_roles ─────────────────────────────────────────────────────────────
drop policy if exists "project_roles_select_member_or_own" on public.project_roles;

-- ── staff_invites ─────────────────────────────────────────────────────────────
drop policy if exists "staff_invites_select_member_or_creator" on public.staff_invites;

-- ── ROLLBACK (recreate the dropped policies; verbatim from 20260706010000) ─────
-- create policy "businesses_select_self" on public.accounts
--   for select to public using (id = (select auth.uid()));
-- create policy "businesses_update_self" on public.accounts
--   for update to authenticated
--   using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
-- create policy "consumers_update_self" on public.consumers
--   for update to authenticated
--   using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
-- create policy "consumer_subscriptions_select_own" on public.consumer_subscriptions
--   for select to public using ((select auth.uid()) = consumer_id);
-- create policy "coupons_select_own" on public.coupons
--   for select to public using ((select auth.uid()) = consumer_id);
-- create policy "project_members_select_self" on public.project_members
--   for select to authenticated using (business_id = (select auth.uid()));
-- create policy "project_subscriptions_select_member" on public.project_subscriptions
--   for select to public using (exists (
--     select 1 from public.project_members m
--     where m.project_id = project_subscriptions.project_id
--       and m.business_id = (select auth.uid())));
-- create policy "reservations_select_own" on public.reservations
--   for select to public using ((select auth.uid()) = consumer_id);
-- create policy "saved_places_select_own" on public.saved_places
--   for select to public using ((select auth.uid()) = consumer_id);
-- create policy "ticket_reviews_select_own" on public.ticket_reviews
--   for select to authenticated using (consumer_id = (select auth.uid()));
-- create policy "tickets_select_own_consumer" on public.tickets
--   for select to authenticated using (consumer_id = (select auth.uid()));
-- create policy "account_invites_select_member_or_creator" on public.account_invites
--   for select to public using (
--     (created_by = (select auth.uid()))
--     or exists (select 1 from public.project_members vm
--       where vm.project_id = account_invites.project_id
--         and vm.business_id = (select auth.uid())));
-- create policy "project_roles_select_member_or_own" on public.project_roles
--   for select to public using (
--     (user_id = (select auth.uid()))
--     or exists (select 1 from public.project_members vm
--       where vm.project_id = project_roles.project_id
--         and vm.business_id = (select auth.uid())));
-- create policy "staff_invites_select_member_or_creator" on public.staff_invites
--   for select to public using (
--     (created_by = (select auth.uid()))
--     or exists (select 1 from public.project_members vm
--       where vm.project_id = staff_invites.project_id
--         and vm.business_id = (select auth.uid())));
