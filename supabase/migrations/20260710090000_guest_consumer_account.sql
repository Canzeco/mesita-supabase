-- Guest consumer account: fixed shared identity (+52 0000000) behind the
-- consumer app's "Continue as guest" button. Signs in with a password grant
-- (no SMS/OTP). The password is intentionally public — the account is a
-- shared throwaway guest identity with a pre-onboarded profile.
--
-- NOTE: the guest auth user + profile were already seeded in the cloud on
-- 2026-07-10 (session work for the consumer guest button); this migration is
-- the repo mirror and is fully idempotent, so `db push` converges cleanly.

create or replace function public.seed_guest_consumer()
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'auth', 'extensions'
as $fn$
declare
  uid uuid;
begin
  select id into uid from auth.users where phone = '520000000';

  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, phone, phone_confirmed_at,
      encrypted_password, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, recovery_token,
      email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      '520000000', now(),
      extensions.crypt('mesita-guest-public', extensions.gen_salt('bf')),
      '{"provider":"phone","providers":["phone"],"role":"consumer"}'::jsonb, '{}'::jsonb,
      now(), now(), '', '', '', ''
    );
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      created_at, updated_at, last_sign_in_at
    ) values (
      gen_random_uuid(), uid,
      jsonb_build_object('sub', uid::text, 'phone', '520000000'),
      'phone', uid::text, now(), now(), now()
    );
  end if;

  -- Pre-onboarded profile so guests land straight in the app (the consumer
  -- (shell) layout gates on full_name + birthday + sex).
  if not exists (select 1 from public.consumers where id = uid) then
    insert into public.consumers
      (id, code, phone, full_name, first_name, birthday, sex, country)
    values
      (uid, public.generate_consumer_code(), '520000000',
       'Guest', 'Guest', '2000-01-01', 'other', 'MX');
  else
    update public.consumers
      set full_name  = coalesce(full_name, 'Guest'),
          first_name = coalesce(first_name, 'Guest'),
          birthday   = coalesce(birthday, '2000-01-01'),
          sex        = coalesce(sex, 'other')
      where id = uid;
  end if;
end;
$fn$;

select public.seed_guest_consumer();

-- admin_reset_database deletes every non-super-admin auth user (the guest has
-- no email) and truncates consumers — re-seed the guest at the end so a reset
-- environment keeps the consumer guest button working. Body is the live cloud
-- definition + the single `perform public.seed_guest_consumer()` line.
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
    public.place_creation_attempts,
    public.consumer_mcp_tokens,
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

  perform public.seed_guest_consumer();

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'preserved_media_assets', true,
    'reset_at', now()
  );
end;
$function$;
