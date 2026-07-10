-- Place Reservations: custom POS/booking endpoint + multi-contact list for the
-- reservationist agent. OpenTable/Resy stay as dedicated URL columns; this adds
-- a free-form endpoint (any POS / booking URL / deep link) and structured
-- contacts the agent can call/message when no online booking path exists.

alter table public.places
  add column if not exists reservation_endpoint text,
  add column if not exists reservation_contacts jsonb not null default '[]'::jsonb;

comment on column public.places.reservation_endpoint is
  'Custom POS / booking endpoint URL (or deep link) for the reservationist. Null = fall back to OpenTable/Resy/phone.';
comment on column public.places.reservation_contacts is
  'jsonb array of reservation contacts: [{name, role?, phone?, email?, notes?}]. Capped in business-web-update-project.';

-- projects_view lists place columns explicitly — recreate so the new fields
-- round-trip through the INSTEAD OF triggers used by business-web-update-project.
create or replace view public.projects_view
with (security_invoker = false)
as
select
  p.id,
  p.created_at,
  p.updated_at,
  p.google_place_id,
  u.slug,
  p.name,
  p.category,
  p.vibe,
  p.price_level,
  u.listing_type,
  u.status,
  p.lat,
  p.lng,
  p.address,
  p.timezone,
  p.closes_at,
  p.phone,
  p.pitch,
  p.story,
  p.photos,
  p.website_url,
  p.instagram_url,
  p.tiktok_url,
  p.facebook_url,
  p.whatsapp_url,
  p.opentable_url,
  p.resy_url,
  p.uber_eats_url,
  u.fiscal_type,
  u.plan,
  p.x_url,
  p.threads_url,
  p.reddit_url,
  p.google_maps_url,
  p.tripadvisor_url,
  p.didi_food_url,
  p.email,
  p.hours,
  p.embedding,
  p.embedding_source_hash,
  p.country,
  p.description,
  p.menu_pdf_url,
  p.tags,
  p.whatsapp_pr_urls,
  p.instagram_pr_urls,
  p.google_business_url,
  p.google_stars_overall,
  p.google_review_count,
  p.google_visitor_count,
  p.mesita_stars_overall,
  p.mesita_stars_food,
  p.mesita_stars_service,
  p.mesita_stars_ambience,
  p.mesita_review_count,
  p.mesita_visitor_count,
  p.instagram_followers_count,
  u.segmentation_basic_enabled,
  u.segmentation_advanced_enabled,
  u.currency,
  p.menu_pdf_name,
  u.welcome_free_rate,
  u.welcome_premium_rate,
  u.free_rate,
  u.premium_rate,
  p.enriched_at,
  p.enrichment_sources,
  p.editorial_summary,
  p.zone,
  p.city,
  p.established_year,
  p.executive_chef,
  u.reward_cap_cents,
  u.requires_story,
  p.facebook_rating,
  p.facebook_followers,
  p.mesita_stars_value,
  p.details,
  p.google_reviews,
  p.menus,
  p.popular_times,
  u.monthly_promo_cap,
  p.products,
  p.category_label,
  u.content_status,
  p.yelp_url,
  p.reservation_endpoint,
  p.reservation_contacts
from public.projects u
join public.places p on p.id = u.id;

comment on view public.projects_view is
  'SECURITY DEFINER join of projects ⋈ places. Accepted advisor 0010 exception — invoker would hide pending/enriching places from consumer browse. EF-only writes via INSTEAD OF triggers.';

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
    yelp_url, reservation_endpoint, reservation_contacts
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
    new.menus, new.popular_times, new.products, new.yelp_url,
    new.reservation_endpoint, coalesce(new.reservation_contacts, '[]'::jsonb)
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
end
$function$;

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
    popular_times = new.popular_times, products = new.products, yelp_url = new.yelp_url,
    reservation_endpoint = new.reservation_endpoint,
    reservation_contacts = coalesce(new.reservation_contacts, '[]'::jsonb)
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
end
$function$;

notify pgrst, 'reload schema';
