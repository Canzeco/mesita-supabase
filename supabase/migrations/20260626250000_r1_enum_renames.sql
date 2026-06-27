-- R1 (nomenclature): enum layer.
--   * TYPE renames:   venue_status→project_status, venue_fiscal_type→project_fiscal_type,
--                     venue_role→project_role, adea_status→content_gen_status
--   * VALUE renames:  story_status waiter_*→staff_*, ticket_status pending_pay→pending_payment
--   * VALUE collapses: member_role drop legacy 'staff'; ticket_kind 9→reservation/coupon;
--                      venue_plan 5→free/pro/ultra then TYPE→membership
--   * COLUMN rename:  units.adea_status→content_status (the column; type already renamed above)
--
-- Grounded 2026-06-26: every legacy value being dropped has ZERO rows in prod
-- (member_role 'staff'=0, ticket_kind non-'none'=0, plan non-'free'=0, ticket_status
-- pending_pay=0, story_status waiter_*=0), so the collapses are loss-free. The 'venues'
-- view depends on venue_plan, so it is DROPPED here and recreated at the tail (R2 then
-- renames the recreated view to projects_view). venue_members.role default '::member_role',
-- units.{plan,fiscal_type,status,adea_status} defaults are re-asserted after each swap.

-- ── 1. Plain TYPE renames (in place; columns keep their values) ───────────────
alter type public.venue_status      rename to project_status;
alter type public.venue_fiscal_type rename to project_fiscal_type;
alter type public.venue_role        rename to project_role;
alter type public.adea_status       rename to content_gen_status;

-- ── 2. Plain VALUE renames (in place; stored column defaults stay valid) ──────
alter type public.story_status  rename value 'waiter_verified' to 'staff_verified';
alter type public.story_status  rename value 'waiter_rejected' to 'staff_rejected';
alter type public.ticket_status rename value 'pending_pay'     to 'pending_payment';

-- ── 3. member_role: drop legacy 'staff' (collapse owner/editor/viewer) ────────
-- Postgres cannot DROP an enum value, so rebuild the type without it.
alter type public.member_role rename to member_role_old;
create type public.member_role as enum ('owner', 'editor', 'viewer');

-- Both venue_members.role AND business_invites.role carry a
-- default 'editor'::member_role. A column default cannot be auto-cast across an
-- enum TYPE swap, so BOTH defaults must be dropped before the type change and
-- re-asserted after (business_invites was previously missed → 42804).
alter table public.venue_members    alter column role drop default;
alter table public.business_invites  alter column role drop default;
alter table public.business_invites
  alter column role type public.member_role using role::text::public.member_role;
alter table public.venue_members
  alter column role type public.member_role using role::text::public.member_role;
alter table public.business_invites  alter column role set default 'editor'::public.member_role;
alter table public.venue_members     alter column role set default 'editor'::public.member_role;

drop type public.member_role_old;

-- ── 4. ticket_kind: collapse 9 → reservation / coupon ────────────────────────
-- Zero non-'none' rows in prod; map reservation-prefixed (r_*) → reservation,
-- everything else → coupon. New default 'coupon' (was 'p_c').
alter type public.ticket_kind rename to ticket_kind_old;
create type public.ticket_kind as enum ('reservation', 'coupon');

alter table public.tickets alter column kind drop default;
alter table public.tickets
  alter column kind type public.ticket_kind
  using (case
           when kind::text like 'r\_%' then 'reservation'
           else 'coupon'
         end)::public.ticket_kind;
alter table public.tickets alter column kind set default 'coupon'::public.ticket_kind;

drop type public.ticket_kind_old;

-- ── 5. venue_plan: collapse 5 → free / pro / ultra, then TYPE → membership ────
-- The 'venues' view selects units.plan, so drop it first; recreated at the tail.
drop view if exists public.venues;

alter type public.venue_plan rename to venue_plan_old;
create type public.membership as enum ('free', 'pro', 'ultra');

alter table public.units alter column plan drop default;
alter table public.units
  alter column plan type public.membership
  using (case
           when plan::text in ('formal_ultra', 'informal_ultra') then 'ultra'
           when plan::text in ('formal_pro',   'informal_pro')   then 'pro'
           else 'free'
         end)::public.membership;
alter table public.units alter column plan set default 'free'::public.membership;

drop type public.venue_plan_old;

-- ── 6. content lifecycle: column units.adea_status → content_status ───────────
-- (the enum TYPE was renamed adea_status→content_gen_status in step 1)
alter table public.units rename column adea_status to content_status;

-- ── 7. recreate the venues view (R2 renames it to projects_view) ──────────────
-- Identical to the pre-drop definition; the only schema deltas are the renamed
-- column (u.content_status) and the renamed plan enum (u.plan now ::membership).
-- NOTE: the view's INSTEAD OF triggers were dropped together with the view. The
-- INSTEAD OF trigger FUNCTIONS (venues_view_insert/update/delete) still reference
-- the now-renamed enums/column and are therefore stale until R2 rebuilds them as
-- projects_view_insert/update/delete and re-attaches the triggers to the renamed
-- view. The view is read-only between R1 and R2 (both ship in the same deploy).
create view public.venues as
 select p.id,
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
    p.yelp_url
   from units u
     join places p on p.id = u.id;

notify pgrst, 'reload schema';
