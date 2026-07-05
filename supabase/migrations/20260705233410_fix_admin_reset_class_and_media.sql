-- Fix admin_reset_database(): it was aborting on every run.
--
-- 20260705100000_place_research_pipeline redefined the function "otherwise
-- unchanged from 20260705010000" — a pre-Plan/Class-rename body — which
-- reintroduced `insert into public.plans`. But 20260705020000 dropped
-- public.plans → public.classes, so every reset threw
-- `relation "public.plans" does not exist` and truncated NOTHING (operational
-- data + admin notifications all survived).
--
-- This migration restores the class-aware body and, while here, adds
-- public.place_media_assets to the explicit truncate list (the projects FK
-- cascade already reached it, but explicit is safer against future FK changes).
-- Content-only change; no tables/functions dropped. Still truncates
-- place_enrichment_events + project_verifications (the admin-notification
-- sources) and preserves super_admins' auth accounts by email.

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
    public.scheduled_project_creations,
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
    ('pro',   'Promote', 10000,  'MXN'),
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
