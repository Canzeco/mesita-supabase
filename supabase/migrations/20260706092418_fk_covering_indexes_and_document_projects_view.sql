-- Perf advisor 0001_unindexed_foreign_keys: add covering indexes for FK columns.
-- All target tables are empty/tiny at this stage, so index builds are instant and
-- effectively non-locking. Idempotent (IF NOT EXISTS) so re-apply / db push is safe.
create index if not exists idx_account_invites_claimed_by on public.account_invites (claimed_by);
create index if not exists idx_account_invites_created_by on public.account_invites (created_by);
create index if not exists idx_app_settings_updated_by on public.app_settings (updated_by);
create index if not exists idx_consumer_pay_notifications_ticket_id on public.consumer_pay_notifications (ticket_id);
create index if not exists idx_coupons_saved_place_id on public.coupons (saved_place_id);
create index if not exists idx_project_roles_invited_by on public.project_roles (invited_by);
create index if not exists idx_project_subscriptions_plan_key on public.project_subscriptions (plan_key);
create index if not exists idx_project_verifications_decided_by on public.project_verifications (decided_by);
create index if not exists idx_reservations_coupon_id on public.reservations (coupon_id);
create index if not exists idx_staff_invites_claimed_by on public.staff_invites (claimed_by);
create index if not exists idx_staff_invites_created_by on public.staff_invites (created_by);
create index if not exists idx_staff_whatsapp_sessions_consumer_id on public.staff_whatsapp_sessions (consumer_id);
create index if not exists idx_staff_whatsapp_sessions_project_id on public.staff_whatsapp_sessions (project_id);
create index if not exists idx_staff_whatsapp_sessions_ticket_id on public.staff_whatsapp_sessions (ticket_id);
create index if not exists idx_super_admins_added_by on public.super_admins (added_by);
create index if not exists idx_ticket_reviews_consumer_id on public.ticket_reviews (consumer_id);
create index if not exists idx_tickets_opened_by on public.tickets (opened_by);
create index if not exists idx_tickets_opened_by_staff_user_id on public.tickets (opened_by_staff_user_id);
create index if not exists idx_tickets_story_verified_by on public.tickets (story_verified_by);

-- Security advisor 0010_security_definer_view: projects_view is an ACCEPTED exception.
-- It is an intentional public read surface (curated columns from projects ⋈ places) that
-- consumer public-browse EFs (consumer-web-list-places / consumer-web-get-place) read via the
-- anon client, relying on DEFINER semantics to serve places across lifecycle states while the
-- base tables stay RLS-locked. Do NOT flip to security_invoker without revisiting public
-- visibility — under the units_select_public_visible policy it would hide non-active / non-ready
-- places from browse and 404 them in detail.
comment on view public.projects_view is
  'Intentional SECURITY DEFINER public read surface (projects join places). Accepted security-advisor 0010 exception; do not flip to security_invoker without revisiting consumer public visibility rules.';
