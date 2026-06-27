-- R2 (nomenclature): table renames + view venues→projects_view (+ its INSTEAD OF
-- trigger fns) + DB function renames + admin_reset_database() truncate-list refresh.
--
-- Depends on R1 (enum renames + venue_plan→membership + units.adea_status→content_status
-- + the venues view recreated read-only with its INSTEAD OF triggers dropped). This
-- file rebuilds those trigger fns with the corrected enum/column refs, renames the
-- view to projects_view, and re-attaches the INSTEAD OF triggers.
--
-- "venue" → "place" for the catalog/profile entity, "project" for the management
-- container. Table-only: businesses→accounts, business_invites→account_invites
-- (the business-* EF caller name stays). units→projects, scheduled_unit_creations→
-- scheduled_project_creations, membership_tiers→plans.

-- ── 1. TABLE renames ─────────────────────────────────────────────────────────
alter table public.venue_media_assets    rename to place_media_assets;
alter table public.venue_categories      rename to place_categories;
alter table public.venue_tags            rename to place_tags;
alter table public.venue_members         rename to project_members;
alter table public.venue_roles           rename to project_roles;
alter table public.venue_verifications   rename to project_verifications;
alter table public.saved_venues          rename to saved_places;
alter table public.units                 rename to projects;
alter table public.scheduled_unit_creations rename to scheduled_project_creations;
alter table public.businesses            rename to accounts;
alter table public.business_invites      rename to account_invites;
alter table public.membership_tiers      rename to plans;

-- ── 2. Rebuild the INSTEAD OF trigger fns as projects_view_* ─────────────────
-- The old venues_view_* bodies referenced now-dropped/renamed enums and the renamed
-- column; these rebuilt versions target the renamed child tables (places/projects),
-- the renamed enums, and the content_status column. Then drop the old fns.
create or replace function public.projects_view_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  insert into public.projects (
    id, created_at, updated_at, slug, status, listing_type, plan, fiscal_type,
    content_status, requires_story, currency, segmentation_basic_enabled,
    segmentation_advanced_enabled, welcome_free_rate, welcome_premium_rate,
    free_rate, premium_rate, monthly_promo_cap, reward_cap_cents
  ) values (
    v_id, coalesce(new.created_at, now()), coalesce(new.updated_at, now()),
    new.slug, coalesce(new.status, 'lead'::public.project_status),
    coalesce(new.listing_type, 'web'::public.listing_type),
    coalesce(new.plan, 'free'::public.membership),
    coalesce(new.fiscal_type, 'formal'::public.project_fiscal_type),
    coalesce(new.content_status, 'queued'::public.content_gen_status),
    coalesce(new.requires_story, false), coalesce(new.currency, 'MXN'),
    coalesce(new.segmentation_basic_enabled, true),
    coalesce(new.segmentation_advanced_enabled, false), new.welcome_free_rate,
    new.welcome_premium_rate, new.free_rate, new.premium_rate,
    new.monthly_promo_cap, new.reward_cap_cents
  );
  new.id := v_id;
  return new;
end$function$;

create or replace function public.projects_view_update()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  update public.projects set
    slug = new.slug, status = new.status, listing_type = new.listing_type,
    plan = new.plan, fiscal_type = new.fiscal_type, content_status = new.content_status,
    requires_story = new.requires_story, currency = new.currency,
    segmentation_basic_enabled = new.segmentation_basic_enabled,
    segmentation_advanced_enabled = new.segmentation_advanced_enabled,
    welcome_free_rate = new.welcome_free_rate, welcome_premium_rate = new.welcome_premium_rate,
    free_rate = new.free_rate, premium_rate = new.premium_rate,
    monthly_promo_cap = new.monthly_promo_cap, reward_cap_cents = new.reward_cap_cents
  where id = old.id;
  return new;
end$function$;

create or replace function public.projects_view_delete()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  delete from public.projects where id = old.id;
  delete from public.places   where id = old.id;
  return old;
end$function$;

drop function if exists public.venues_view_insert();
drop function if exists public.venues_view_update();
drop function if exists public.venues_view_delete();

-- ── 3. VIEW rename + re-attach the INSTEAD OF triggers ───────────────────────
alter view public.venues rename to projects_view;

create trigger projects_view_insert_trg instead of insert on public.projects_view
  for each row execute function public.projects_view_insert();
create trigger projects_view_update_trg instead of update on public.projects_view
  for each row execute function public.projects_view_update();
create trigger projects_view_delete_trg instead of delete on public.projects_view
  for each row execute function public.projects_view_delete();

-- ── 4. seed / sync DB function renames (recreate with renamed table refs) ────
alter function public.seed_venue_categories() rename to seed_place_categories;
alter function public.seed_venue_tags()       rename to seed_place_tags;

-- sync fn: rename + retarget place_categories (was venue_categories) + trigger
alter function public.sync_venue_category_label() rename to sync_place_category_label;
create or replace function public.sync_place_category_label()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  if new.category is null or btrim(new.category) = '' then
    new.category_label := null;
    return new;
  end if;

  select pc.label
    into new.category_label
    from public.place_categories pc
   where pc.slug = new.category
   limit 1;

  if new.category_label is null then
    new.category_label := initcap(replace(new.category, '_', ' '));
  end if;

  return new;
end;
$function$;

drop trigger if exists places_sync_category_label on public.places;
create trigger places_sync_category_label before insert or update of category
  on public.places for each row execute function public.sync_place_category_label();

-- ── 5. saved_places coupon triggers (rename fns; bodies refer to renamed table) ─
-- NOTE: the venue_id column + ON CONFLICT (consumer_id, venue_id) become
-- project_id in R3, which rebuilds these bodies again. Here we only rename the fns
-- and point them at the renamed projects table; venue_id column refs stay until R3.
alter function public.tg_saved_venues_issue_coupon()  rename to tg_saved_places_issue_coupon;
alter function public.tg_saved_venues_cancel_coupon() rename to tg_saved_places_cancel_coupon;

create or replace function public.tg_saved_places_issue_coupon()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v record;
begin
  select listing_type, welcome_free_rate, welcome_premium_rate,
         free_rate, premium_rate, currency
    into v
  from public.projects
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

create or replace function public.tg_saved_places_cancel_coupon()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update public.coupons
    set status = 'cancelled', cancelled_at = now()
    where consumer_id = old.consumer_id
      and venue_id    = old.venue_id
      and status      = 'active';
  return old;
end;
$function$;

drop trigger if exists saved_venues_issue_coupon  on public.saved_places;
drop trigger if exists saved_venues_cancel_coupon on public.saved_places;
create trigger saved_places_issue_coupon after insert on public.saved_places
  for each row execute function public.tg_saved_places_issue_coupon();
create trigger saved_places_cancel_coupon after delete on public.saved_places
  for each row execute function public.tg_saved_places_cancel_coupon();

-- ── 6. scheduler fn: rename + retarget renamed table + new EF URL slug ────────
-- run_scheduled_unit_creations → run_scheduled_project_creations; the polled table
-- is now scheduled_project_creations and the EF slug becomes
-- scheduler-run-project-creations (was atlas-run-scheduled-create).
alter function public.run_scheduled_unit_creations() rename to run_scheduled_project_creations;
create or replace function public.run_scheduled_project_creations()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'net', 'vault'
as $function$
declare
  v_key   text;
  v_url   text := 'https://yjalywfzdelacdzccpgb.supabase.co/functions/v1/scheduler-run-project-creations';
  v_row   public.scheduled_project_creations%rowtype;
  v_req   bigint;
  v_count integer := 0;
begin
  -- REAP first: 'running' rows whose EF never reported back within 5 min.
  update public.scheduled_project_creations
  set status = case when attempts >= 5 then 'failed' else 'pending' end,
      error  = case when attempts >= 5 then 'max attempts reached' else 'reaped: stuck running' end
  where status = 'running'
    and updated_at < now() - interval '5 minutes';

  -- Service bearer from Vault (seeded ONCE by the operator).
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'scheduler_service_role_key'
  limit 1;
  if v_key is null then
    raise warning 'run_scheduled_project_creations: vault secret scheduler_service_role_key missing — seed it (see migration footer)';
    return 0;
  end if;

  -- Claim a small batch of DUE, under-cap rows.
  for v_row in
    select *
    from public.scheduled_project_creations
    where status = 'pending'
      and exec_at <= now()
      and attempts < 5
    order by exec_at asc
    for update skip locked
    limit 3
  loop
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key,
        'X-Internal-Caller', 'scheduler-poller'
      ),
      body    := jsonb_build_object('placeId', v_row.place_id, 'scheduled_id', v_row.id),
      timeout_milliseconds := 120000
    ) into v_req;

    update public.scheduled_project_creations
    set status = 'running',
        attempts = attempts + 1,
        net_request_id = v_req,
        error = null
    where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

-- ── 7. admin_reset_database(): refresh truncate list + seed calls to new names ─
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
    public.saved_places,
    public.tickets,
    public.project_verifications,
    public.account_invites,
    public.staff_invites,
    public.project_roles,
    public.project_members,
    public.projects,
    public.places,
    public.consumers,
    public.accounts
  restart identity cascade;

  update public.consumer_code_counter set next_value = 0 where id = 1;

  insert into public.plans
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

  perform public.seed_place_categories();
  perform public.seed_place_tags();

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

notify pgrst, 'reload schema';
