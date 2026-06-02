-- Staff Ops WhatsApp transcript (inbound + outbound) for LLM context.

create table public.staff_whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  twilio_message_sid text unique,
  created_at timestamptz not null default now(),
  constraint staff_whatsapp_messages_body_len check (char_length(body) <= 4000)
);

create index staff_whatsapp_messages_phone_created_idx
  on public.staff_whatsapp_messages (phone_e164, created_at desc);

comment on table public.staff_whatsapp_messages is
  'Mesita Ops WhatsApp transcript per staff phone. Service-role only; last N rows feed the LLM.';

alter table public.staff_whatsapp_messages enable row level security;

-- admin_reset_database: include new table
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
    public.stripe_events,
    public.reservations,
    public.coupons,
    public.saved_venues,
    public.cashback_ledger,
    public.tickets,
    public.venue_verifications,
    public.business_invites,
    public.staff_invites,
    public.venue_roles,
    public.venue_members,
    public.venues,
    public.consumers,
    public.businesses
  restart identity cascade;

  update public.consumer_code_counter set next_value = 0 where id = 1;

  insert into public.membership_tiers
    (key, label, rank, follower_threshold, monthly_reservation_limit, price_cents, currency, recommendation_weight)
  values
    ('free',    'Free',    0, null, 2,    0,     'MXN', 1.0),
    ('premium', 'Premium', 1, 1000, null, 20000, 'MXN', 1.5)
  on conflict (key) do update set
    label                     = excluded.label,
    rank                      = excluded.rank,
    follower_threshold        = excluded.follower_threshold,
    monthly_reservation_limit = excluded.monthly_reservation_limit,
    price_cents               = excluded.price_cents,
    currency                  = excluded.currency,
    recommendation_weight     = excluded.recommendation_weight;

  perform public.seed_venue_categories();

  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (
       select lower(email) from public.super_admins
     );
  get diagnostics deleted_users = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'preserved_media_assets', true,
    'reset_at', now()
  );
end;
$function$;
