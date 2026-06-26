-- ============================================================================
-- Split `venues` into `units` (the owned Mesita entity) + `places` (the
-- physical / Atlas-sourced profile). 1:1 via a SHARED primary key:
--   units.id == places.id  (units.id is also an FK -> places.id ON DELETE CASCADE)
--
-- Why shared-PK and not a separate place_id: venues is 1:1 with its place, and
-- every one of the 12 inbound FKs (tickets, reservations, venue_members, ...)
-- is an ENTITY relationship, so they all repoint to units(id). Keeping
-- units.id == old venues.id means none of those child rows need remapping.
--
-- Strategy (type-safe; only ~16 columns physically move):
--   1. RENAME venues -> places  (places keeps the exact types/defaults/checks
--      of the 70 profile columns, incl. the `embedding` vector and all enums).
--   2. CREATE units, backfill the 16 entity columns from places, drop them from
--      places. units.id is the same uuid as the place (shared PK).
--   3. Repoint the 12 inbound FKs places -> units.
--   4. Recreate RLS (public visibility now gated on units.status + adea_status).
--   5. Expose a `venues` COMPATIBILITY VIEW (security_invoker=on) with the
--      original 86-column shape + INSTEAD OF triggers, so the ~180 existing
--      read/write sites keep working until they are migrated to units/places.
--
-- Data volume at migration time: 1 row. This is a pre-launch reshape.
-- The migration runner wraps this file in a single transaction (repo
-- convention — no explicit begin/commit), so the whole reshape is atomic.
-- ============================================================================

-- ── 1. Rename the base table; it now holds the PLACE profile ────────────────
alter table public.venues rename to places;

-- Drop the objects that depend on the 16 columns about to leave `places`, so
-- the DROP COLUMNs below are clean. (The public-visibility policy reads
-- status/adea_status; the rate/promo/reward checks read the rate columns; the
-- slug unique constraint moves to units.)
drop policy if exists venues_select_public_visible on public.places;
alter table public.places drop constraint if exists venues_slug_key;
alter table public.places drop constraint if exists venues_promo_rate_legal_values;
alter table public.places drop constraint if exists venues_monthly_promo_cap_legal_values;
alter table public.places drop constraint if exists venues_reward_cap_cents_check;

-- ── 2. The UNITS entity (shared PK with places) ─────────────────────────────
create table public.units (
  id            uuid primary key,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  slug          text not null,
  status        public.venue_status      not null default 'lead',
  listing_type  public.listing_type      not null default 'web',
  plan          public.venue_plan        not null default 'free',
  fiscal_type   public.venue_fiscal_type not null default 'formal',
  adea_status   public.adea_status       not null default 'queued',
  requires_story boolean not null default false,
  currency      text not null default 'MXN',
  segmentation_basic_enabled    boolean not null default true,
  segmentation_advanced_enabled boolean not null default false,
  welcome_free_rate    smallint,
  welcome_premium_rate smallint,
  free_rate            smallint,
  premium_rate         smallint,
  monthly_promo_cap    smallint,
  reward_cap_cents     integer,
  constraint units_place_fk foreign key (id) references public.places(id) on delete cascade,
  constraint units_slug_key unique (slug),
  constraint units_reward_cap_cents_check check (reward_cap_cents is null or reward_cap_cents >= 0),
  constraint units_monthly_promo_cap_legal_values
    check (monthly_promo_cap is null or monthly_promo_cap = any (array[200,500,1000,2000])),
  constraint units_promo_rate_legal_values check (
    (welcome_free_rate    is null or welcome_free_rate    = any (array[10,20,50,70])) and
    (welcome_premium_rate is null or welcome_premium_rate = any (array[10,20,50,70])) and
    (free_rate            is null or free_rate            = any (array[10,20,50,70])) and
    (premium_rate         is null or premium_rate         = any (array[10,20,50,70]))
  )
);

-- Backfill the entity from the (renamed) profile rows. id is shared 1:1.
insert into public.units (
  id, created_at, updated_at, slug, status, listing_type, plan, fiscal_type,
  adea_status, requires_story, currency, segmentation_basic_enabled,
  segmentation_advanced_enabled, welcome_free_rate, welcome_premium_rate,
  free_rate, premium_rate, monthly_promo_cap, reward_cap_cents
)
select
  id, created_at, updated_at, slug, status, listing_type, plan, fiscal_type,
  adea_status, requires_story, currency, segmentation_basic_enabled,
  segmentation_advanced_enabled, welcome_free_rate, welcome_premium_rate,
  free_rate, premium_rate, monthly_promo_cap, reward_cap_cents
from public.places;

-- Now drop the 16 entity columns from places.
alter table public.places
  drop column slug,
  drop column status,
  drop column listing_type,
  drop column plan,
  drop column fiscal_type,
  drop column adea_status,
  drop column requires_story,
  drop column currency,
  drop column segmentation_basic_enabled,
  drop column segmentation_advanced_enabled,
  drop column welcome_free_rate,
  drop column welcome_premium_rate,
  drop column free_rate,
  drop column premium_rate,
  drop column monthly_promo_cap,
  drop column reward_cap_cents;

-- ── 3. Repoint the 12 inbound FKs: places -> units ──────────────────────────
-- (After the rename they transiently reference places(id); move them to the
-- entity. on-delete behavior preserved exactly.)
alter table public.venue_members          drop constraint venue_members_venue_id_fkey,
  add constraint venue_members_venue_id_fkey foreign key (venue_id) references public.units(id) on delete cascade;
alter table public.tickets                 drop constraint tickets_venue_id_fkey,
  add constraint tickets_venue_id_fkey foreign key (venue_id) references public.units(id) on delete restrict;
alter table public.venue_roles             drop constraint venue_roles_venue_id_fkey,
  add constraint venue_roles_venue_id_fkey foreign key (venue_id) references public.units(id) on delete cascade;
alter table public.staff_invites           drop constraint staff_invites_venue_id_fkey,
  add constraint staff_invites_venue_id_fkey foreign key (venue_id) references public.units(id) on delete cascade;
alter table public.venue_verifications     drop constraint venue_verifications_venue_id_fkey,
  add constraint venue_verifications_venue_id_fkey foreign key (venue_id) references public.units(id) on delete cascade;
alter table public.business_invites        drop constraint manager_invites_venue_id_fkey,
  add constraint manager_invites_venue_id_fkey foreign key (venue_id) references public.units(id) on delete cascade;
alter table public.saved_venues            drop constraint saved_venues_venue_id_fkey,
  add constraint saved_venues_venue_id_fkey foreign key (venue_id) references public.units(id) on delete cascade;
alter table public.coupons                 drop constraint coupons_venue_id_fkey,
  add constraint coupons_venue_id_fkey foreign key (venue_id) references public.units(id) on delete restrict;
alter table public.reservations            drop constraint reservations_venue_id_fkey,
  add constraint reservations_venue_id_fkey foreign key (venue_id) references public.units(id) on delete restrict;
alter table public.venue_media_assets      drop constraint venue_media_assets_venue_id_fkey,
  add constraint venue_media_assets_venue_id_fkey foreign key (venue_id) references public.units(id) on delete cascade;
alter table public.staff_whatsapp_sessions drop constraint staff_whatsapp_sessions_venue_id_fkey,
  add constraint staff_whatsapp_sessions_venue_id_fkey foreign key (venue_id) references public.units(id) on delete cascade;
alter table public.ticket_reviews          drop constraint ticket_reviews_venue_id_fkey,
  add constraint ticket_reviews_venue_id_fkey foreign key (venue_id) references public.units(id) on delete cascade;

-- ── 4. Triggers ─────────────────────────────────────────────────────────────
-- updated_at on units (set_updated_at already exists). The places copy of the
-- trigger came along with the rename; rename both for clarity. The category
-- label sync stays on places (category lives on places).
alter trigger venues_set_updated_at        on public.places rename to places_set_updated_at;
alter trigger venues_sync_category_label   on public.places rename to places_sync_category_label;
create trigger units_set_updated_at before update on public.units
  for each row execute function public.set_updated_at();

-- ── 5. RLS ──────────────────────────────────────────────────────────────────
alter table public.units  enable row level security;
-- places already had RLS enabled (inherited from venues); keep it on.
alter table public.places enable row level security;

-- Public catalog visibility now lives on the entity.
create policy units_select_public_visible on public.units
  for select to anon, authenticated
  using (status = any (array['active'::public.venue_status,'lead'::public.venue_status])
         and adea_status = 'ready'::public.adea_status);

-- A place is publicly readable iff its unit is publicly visible. The subquery
-- is itself subject to units' RLS for the same role, so this composes to "the
-- place's unit is a ready, active/lead listing" without duplicating the rule.
create policy places_select_public_visible on public.places
  for select to anon, authenticated
  using (exists (select 1 from public.units u where u.id = places.id));

-- Writes stay service-role only (no anon/authenticated write policy = denied),
-- exactly as venues was. Indexes for the visibility filter.
create index units_status_idx       on public.units (status);
create index units_adea_status_idx  on public.units (adea_status);

-- Table grants (places preserved venues' grants through the rename; units/view
-- are new). PostgREST needs SELECT for the security_invoker view to read as the
-- caller role; service_role keeps full access for the Edge Functions.
grant select on public.units to anon, authenticated;
grant all    on public.units to service_role;
grant select on public.places to anon, authenticated;
grant all    on public.places to service_role;

-- ── 6. `venues` compatibility VIEW (original 86-column shape) ───────────────
-- security_invoker=on so the underlying units/places RLS applies to the caller.
create view public.venues with (security_invoker = on) as
select
  p.id, p.created_at, p.updated_at, p.google_place_id, u.slug, p.name, p.category,
  p.vibe, p.price_level, u.listing_type, u.status, p.lat, p.lng, p.address,
  p.timezone, p.closes_at, p.phone, p.pitch, p.story, p.photos, p.website_url,
  p.instagram_url, p.tiktok_url, p.facebook_url, p.whatsapp_url, p.opentable_url,
  p.resy_url, p.uber_eats_url, u.fiscal_type, u.plan, p.x_url, p.threads_url,
  p.reddit_url, p.google_maps_url, p.tripadvisor_url, p.didi_food_url, p.email,
  p.hours, p.embedding, p.embedding_source_hash, p.country, p.description,
  p.menu_pdf_url, p.tags, p.whatsapp_pr_urls, p.instagram_pr_urls,
  p.google_business_url, p.google_stars_overall, p.google_review_count,
  p.google_visitor_count, p.mesita_stars_overall, p.mesita_stars_food,
  p.mesita_stars_service, p.mesita_stars_ambience, p.mesita_review_count,
  p.mesita_visitor_count, p.instagram_followers_count,
  u.segmentation_basic_enabled, u.segmentation_advanced_enabled, u.currency,
  p.menu_pdf_name, u.welcome_free_rate, u.welcome_premium_rate, u.free_rate,
  u.premium_rate, p.enriched_at, p.enrichment_sources, p.editorial_summary,
  p.zone, p.city, p.established_year, p.executive_chef, u.reward_cap_cents,
  u.requires_story, p.facebook_rating, p.facebook_followers, p.mesita_stars_value,
  p.details, p.google_reviews, p.menus, p.popular_times, u.monthly_promo_cap,
  p.products, p.category_label, u.adea_status, p.yelp_url
from public.units u
join public.places p on p.id = u.id;

grant select on public.venues to anon, authenticated;
grant all    on public.venues to service_role;

-- INSTEAD OF triggers so legacy writers (.from('venues').insert/update/delete)
-- keep working transparently until migrated to units/places.
create or replace function public.venues_view_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.places (
    id, created_at, updated_at, google_place_id, name, category, category_label,
    vibe, price_level, lat, lng, address, timezone, closes_at, phone, pitch, story,
    photos, website_url, instagram_url, tiktok_url, facebook_url, whatsapp_url,
    opentable_url, resy_url, uber_eats_url, x_url, threads_url, reddit_url,
    google_maps_url, tripadvisor_url, didi_food_url, email, hours, embedding,
    embedding_source_hash, country, description, menu_pdf_url, tags,
    whatsapp_pr_urls, instagram_pr_urls, google_business_url, google_stars_overall,
    google_review_count, google_visitor_count, mesita_stars_overall,
    mesita_stars_food, mesita_stars_service, mesita_stars_ambience,
    mesita_review_count, mesita_visitor_count, instagram_followers_count,
    menu_pdf_name, enriched_at, enrichment_sources, editorial_summary, zone, city,
    established_year, executive_chef, facebook_rating, facebook_followers,
    mesita_stars_value, details, google_reviews, menus, popular_times, products,
    yelp_url
  ) values (
    coalesce(new.id, gen_random_uuid()), coalesce(new.created_at, now()),
    coalesce(new.updated_at, now()), new.google_place_id, new.name, new.category,
    new.category_label, new.vibe, new.price_level, new.lat, new.lng, new.address,
    new.timezone, new.closes_at, new.phone, new.pitch, new.story,
    coalesce(new.photos, '{}'), new.website_url, new.instagram_url, new.tiktok_url,
    new.facebook_url, new.whatsapp_url, new.opentable_url, new.resy_url,
    new.uber_eats_url, new.x_url, new.threads_url, new.reddit_url,
    new.google_maps_url, new.tripadvisor_url, new.didi_food_url, new.email,
    new.hours, new.embedding, new.embedding_source_hash, new.country,
    new.description, new.menu_pdf_url, coalesce(new.tags, '{}'),
    coalesce(new.whatsapp_pr_urls, '{}'), coalesce(new.instagram_pr_urls, '{}'),
    new.google_business_url, new.google_stars_overall, new.google_review_count,
    new.google_visitor_count, new.mesita_stars_overall, new.mesita_stars_food,
    new.mesita_stars_service, new.mesita_stars_ambience, new.mesita_review_count,
    new.mesita_visitor_count, new.instagram_followers_count, new.menu_pdf_name,
    new.enriched_at, new.enrichment_sources, new.editorial_summary, new.zone,
    new.city, new.established_year, new.executive_chef, new.facebook_rating,
    new.facebook_followers, new.mesita_stars_value, new.details, new.google_reviews,
    new.menus, new.popular_times, new.products, new.yelp_url
  ) returning id into v_id;

  insert into public.units (
    id, created_at, updated_at, slug, status, listing_type, plan, fiscal_type,
    adea_status, requires_story, currency, segmentation_basic_enabled,
    segmentation_advanced_enabled, welcome_free_rate, welcome_premium_rate,
    free_rate, premium_rate, monthly_promo_cap, reward_cap_cents
  ) values (
    v_id, coalesce(new.created_at, now()), coalesce(new.updated_at, now()),
    new.slug, coalesce(new.status, 'lead'::public.venue_status),
    coalesce(new.listing_type, 'web'::public.listing_type),
    coalesce(new.plan, 'free'::public.venue_plan),
    coalesce(new.fiscal_type, 'formal'::public.venue_fiscal_type),
    coalesce(new.adea_status, 'queued'::public.adea_status),
    coalesce(new.requires_story, false), coalesce(new.currency, 'MXN'),
    coalesce(new.segmentation_basic_enabled, true),
    coalesce(new.segmentation_advanced_enabled, false), new.welcome_free_rate,
    new.welcome_premium_rate, new.free_rate, new.premium_rate,
    new.monthly_promo_cap, new.reward_cap_cents
  );
  new.id := v_id;
  return new;
end$$;

create or replace function public.venues_view_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.places set
    google_place_id = new.google_place_id, name = new.name, category = new.category,
    category_label = new.category_label, vibe = new.vibe, price_level = new.price_level,
    lat = new.lat, lng = new.lng, address = new.address, timezone = new.timezone,
    closes_at = new.closes_at, phone = new.phone, pitch = new.pitch, story = new.story,
    photos = new.photos, website_url = new.website_url, instagram_url = new.instagram_url,
    tiktok_url = new.tiktok_url, facebook_url = new.facebook_url,
    whatsapp_url = new.whatsapp_url, opentable_url = new.opentable_url,
    resy_url = new.resy_url, uber_eats_url = new.uber_eats_url, x_url = new.x_url,
    threads_url = new.threads_url, reddit_url = new.reddit_url,
    google_maps_url = new.google_maps_url, tripadvisor_url = new.tripadvisor_url,
    didi_food_url = new.didi_food_url, email = new.email, hours = new.hours,
    embedding = new.embedding, embedding_source_hash = new.embedding_source_hash,
    country = new.country, description = new.description, menu_pdf_url = new.menu_pdf_url,
    tags = new.tags, whatsapp_pr_urls = new.whatsapp_pr_urls,
    instagram_pr_urls = new.instagram_pr_urls, google_business_url = new.google_business_url,
    google_stars_overall = new.google_stars_overall, google_review_count = new.google_review_count,
    google_visitor_count = new.google_visitor_count, mesita_stars_overall = new.mesita_stars_overall,
    mesita_stars_food = new.mesita_stars_food, mesita_stars_service = new.mesita_stars_service,
    mesita_stars_ambience = new.mesita_stars_ambience, mesita_review_count = new.mesita_review_count,
    mesita_visitor_count = new.mesita_visitor_count, instagram_followers_count = new.instagram_followers_count,
    menu_pdf_name = new.menu_pdf_name, enriched_at = new.enriched_at,
    enrichment_sources = new.enrichment_sources, editorial_summary = new.editorial_summary,
    zone = new.zone, city = new.city, established_year = new.established_year,
    executive_chef = new.executive_chef, facebook_rating = new.facebook_rating,
    facebook_followers = new.facebook_followers, mesita_stars_value = new.mesita_stars_value,
    details = new.details, google_reviews = new.google_reviews, menus = new.menus,
    popular_times = new.popular_times, products = new.products, yelp_url = new.yelp_url
  where id = old.id;

  update public.units set
    slug = new.slug, status = new.status, listing_type = new.listing_type,
    plan = new.plan, fiscal_type = new.fiscal_type, adea_status = new.adea_status,
    requires_story = new.requires_story, currency = new.currency,
    segmentation_basic_enabled = new.segmentation_basic_enabled,
    segmentation_advanced_enabled = new.segmentation_advanced_enabled,
    welcome_free_rate = new.welcome_free_rate, welcome_premium_rate = new.welcome_premium_rate,
    free_rate = new.free_rate, premium_rate = new.premium_rate,
    monthly_promo_cap = new.monthly_promo_cap, reward_cap_cents = new.reward_cap_cents
  where id = old.id;
  return new;
end$$;

create or replace function public.venues_view_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.units  where id = old.id;  -- cascades the 12 dependents
  delete from public.places where id = old.id;
  return old;
end$$;

create trigger venues_view_insert_trg instead of insert on public.venues
  for each row execute function public.venues_view_insert();
create trigger venues_view_update_trg instead of update on public.venues
  for each row execute function public.venues_view_update();
create trigger venues_view_delete_trg instead of delete on public.venues
  for each row execute function public.venues_view_delete();

-- ── 7. Repoint the 2 DB functions that referenced the venues TABLE ──────────
-- admin_reset_database TRUNCATEs venues — illegal on a view — so it must target
-- the real tables now. (Also satisfies "update the super-admin reset fn after
-- architectural changes".) Body is otherwise identical to the pre-split version.
create or replace function public.admin_reset_database()
returns jsonb language plpgsql security definer
set search_path to 'pg_catalog','public','auth' as $function$
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
    public.tickets,
    public.venue_verifications,
    public.business_invites,
    public.staff_invites,
    public.venue_roles,
    public.venue_members,
    public.units,
    public.places,
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
  perform public.seed_venue_tags();

  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (select lower(email) from public.super_admins);
  get diagnostics deleted_users = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'preserved_media_assets', true,
    'reset_at', now()
  );
end;
$function$;

-- Hot trigger on every save — read the rate fields straight from units (all 6
-- columns it needs now live there) instead of through the venues view.
create or replace function public.tg_saved_venues_issue_coupon()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v record;
begin
  select listing_type, welcome_free_rate, welcome_premium_rate,
         free_rate, premium_rate, currency
    into v
  from public.units
  where id = new.venue_id;

  if not found or v.listing_type <> 'partner' then
    return new;
  end if;

  insert into public.coupons (
    consumer_id, venue_id, saved_venue_id,
    welcome_free_rate, welcome_premium_rate, free_rate, premium_rate,
    cap_cents, currency
  ) values (
    new.consumer_id, new.venue_id, new.id,
    v.welcome_free_rate, v.welcome_premium_rate, v.free_rate, v.premium_rate,
    0, coalesce(v.currency, 'MXN')
  )
  on conflict (consumer_id, venue_id) where status = 'active' do nothing;

  return new;
end;
$function$;

notify pgrst, 'reload schema';
