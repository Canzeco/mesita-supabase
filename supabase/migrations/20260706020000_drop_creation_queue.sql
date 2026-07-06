-- ============================================================================
-- MESITA-127 — drop the staggered creation queue: creation is IMMEDIATE now.
--
-- Every caller (admin-web-create-unit, business-web-create-project, and the
-- new consumer-web-create-place) runs the shared createMinimalPlace core
-- inline; the only scheduled machinery left is the Enricher pipeline
-- (run-place-enrichment-stages over place_research, untouched here).
--
-- Removed:
--   * pg_cron job  run-scheduled-project-creations (10 s creation poller)
--   * function     public.run_scheduled_project_creations()
--   * table        public.scheduled_project_creations
--   * (cloud EF    supabase-cron-run-project-creations — deleted alongside)
--
-- Kept: prune-cron-run-details (the 20 s enrichment poller still writes
-- cron.job_run_details rows that need the daily sweep).
--
-- admin_reset_database() is recreated from the LATEST body
-- (20260705233410_fix_admin_reset_class_and_media — class-aware) with only
-- the dropped table removed from the truncate list. Never copy an older body
-- (that exact mistake reintroduced public.plans and broke every reset).
-- One deliberate fix while here: 233410's body re-seeded business_plans with
-- the retired 'Promote' label; 20260705020000 renamed it to 'Pro', so the
-- reset must re-seed 'Pro' (same regression class 233410 itself was fixing).
-- ============================================================================

-- ── Unschedule the creation poller ──────────────────────────────────────────
select cron.unschedule('run-scheduled-project-creations')
where exists (select 1 from cron.job where jobname = 'run-scheduled-project-creations');

-- ── Drop the poller function and the queue table ─────────────────────────────
drop function if exists public.run_scheduled_project_creations();
drop table if exists public.scheduled_project_creations;

-- ── admin_reset_database(): 20260705233410 body minus scheduled_project_creations
create or replace function public.admin_reset_database()
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'pg_catalog', 'public', 'auth'
as $function$
declare
  deleted_users bigint;
begin
  truncate table
    public.ticket_reviews,
    public.consumer_pay_notifications,
    public.staff_whatsapp_messages,
    public.staff_whatsapp_sessions,
    public.consumer_subscriptions,
    public.project_subscriptions,
    public.stripe_events,
    public.reservations,
    public.coupons,
    public.saved_places,
    public.tickets,
    public.project_verifications,
    public.account_invites,
    public.staff_invites,
    public.project_roles,
    public.project_members,
    public.place_enrichment_events,
    public.place_media_assets,
    public.place_research,
    public.projects,
    public.places,
    public.consumers,
    public.accounts
  restart identity cascade;

  update public.consumer_code_counter set next_value = 0 where id = 1;

  insert into public.classes
    (key, label, rank, follower_threshold, monthly_reservation_limit, price_cents, currency, recommendation_weight)
  values
    ('free',    'Free',    0, null, 2,    0,     'MXN', 1.0),
    ('premium', 'Premium', 1, 1000, null, 10000, 'MXN', 1.5)
  on conflict (key) do update set
    label                     = excluded.label,
    rank                      = excluded.rank,
    follower_threshold        = excluded.follower_threshold,
    monthly_reservation_limit = excluded.monthly_reservation_limit,
    price_cents               = excluded.price_cents,
    currency                  = excluded.currency,
    recommendation_weight     = excluded.recommendation_weight;

  -- stripe_price_id is intentionally not overwritten: the reset rebuilds a
  -- clean working env but keeps the provisioned Stripe wiring.
  insert into public.business_plans (key, label, price_cents, currency) values
    ('pro',   'Pro',     10000,  'MXN'),
    ('ultra', 'Ultra',   500000, 'MXN')
  on conflict (key) do update set
    label       = excluded.label,
    price_cents = excluded.price_cents,
    currency    = excluded.currency;

  perform public.seed_place_categories();
  perform public.seed_place_tags();

  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (select lower(email) from public.super_admins);
  get diagnostics deleted_users = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    -- Known-inaccurate flag, intentionally left true per prior decision
    -- (media assets are in fact truncated); not re-fixed here.
    'preserved_media_assets', true,
    'reset_at', now()
  );
end;
$function$;

notify pgrst, 'reload schema';
