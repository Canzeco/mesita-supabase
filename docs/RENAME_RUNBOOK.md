# Mesita — Nomenclature Rename + Structural Runbook (Phases 5–7)

Coordinated release: changes data semantics + object names and **breaks web + mobile + n8n clients**. Execute as one window — DB migrations + EF deploys + web/mobile/n8n + Notion together. Forward-only migrations; never edit applied files. Prod apply is user-run (guarded).

## ⚠️ Client-breaking checklist (must land in the same window)
- **B-1** EF slug renames — update every web/mobile call literal (create/update/delete/list-`unit`→`project`, schedule-*, recommend-`deck`/`catalog`→`swipe`/`map`, invite-`waiter`→`staff`, invite-`business`→`member`, grant-`membership`→`plan`).
- **B-2** bucket `venue-images`→`place-images` — any client URL on the old path breaks.
- **B-3** view `venues`→`projects_view` — any client `from("venues")` breaks (should be EF-only; verify).
- **B-4** enum value collapses — clients sending/parsing `formal_pro`/`pending_pay`/`waiter_*`/`p_c` break.
- **B-5** `consumer-mock-story-detect` is LIVE in consumer web — do NOT drop.
- **B-6** n8n Enricher calls `atlas-*` slugs (`save-unit-data`,`update-unit-data`,`save-place-media`,`get-config`) — update to `enricher-*` in the same window (it's deployed inactive, so update before activation).

## Phase 5 — enum collapses (`…_enum_collapses.sql`)
Type-swap pattern per enum (drop column defaults → `ALTER TYPE … USING` cast → re-add defaults → drop old type → rename). All target columns currently have ~0 rows.
- **member_role**: drop legacy `staff` → `(owner, editor, viewer)`.
- **ticket_kind**: 9 cryptic → `(reservation, coupon)` via `CASE WHEN kind::text LIKE 'r%' THEN 'reservation' ELSE 'coupon' END` (confirm mapping).
- **venue_plan**: `(free, formal_pro, formal_ultra, informal_pro, informal_ultra)` → `(free, pro, ultra)` mapping `formal_*`/`informal_*`→base; rename type → `membership`; `fiscal_type` stays the separate axis. **Requires `DROP VIEW venues` first, recreate after** (R2 then renames it).
- **in-place value renames**: `story_status` `waiter_verified/rejected`→`staff_*`; `ticket_status` `pending_pay`→`pending_payment`.
- Deploy the EFs that write these literals in lockstep.

## Phase 6 — storage bucket rename (`venue-images` → `place-images`)
Supabase has no native bucket rename — do it as: create `place-images` (public, same policy) → copy the 2639 objects → update `venue_media_assets.storage_path`/`public_url` → flip `IMAGE_BUCKET` const in `atlas-save-place-media` (→`enricher-save-place-media` after R5) → update `admin_reset_database()` preserve-invariant → delete old bucket once verified. Flag B-2.

## Phase 7 — full nomenclature rename (R0 → R5, each its own migration)
- **R0** constraint/index renames: `venues_*`→`places_*` on `places` (`venues_pkey`,`venues_google_place_id_key`,`venues_country_idx`,`venues_embedding_hnsw`); `manager_invites_*`→`business_invites_*` (FK + 2 policies).
- **R1** enum TYPE renames: `venue_status`→`project_status`, `venue_fiscal_type`→`project_fiscal_type`, `venue_role`→`project_role`, `adea_status`→`content_gen_status`, `listing_type`→`project_listing_type` (`venue_plan` already → `membership` in P5).
- **R2** tables/view/fns: `units`→`projects`, `venue_members`→`project_members`, `venue_roles`→`project_roles`, `venue_verifications`→`project_verifications`, `business_invites`→`account_invites`, `saved_venues`→`saved_places`, `venue_media_assets`→`place_media_assets`, `venue_categories`→`place_categories`, `venue_tags`→`place_tags`, `membership_tiers`→`plans`, `scheduled_unit_creations`→`scheduled_project_creations`; view `venues`→`projects_view` (+ `venues_view_*` fns → `projects_view_*`, re-apply Phase-4 REVOKEs); `seed_venue_*`→`seed_place_*`, `sync_venue_category_label`→`sync_place_category_label`, `tg_saved_venues_*`→`tg_saved_places_*`, `run_scheduled_unit_creations`→`run_scheduled_project_creations`; update `admin_reset_database()` truncate list.
- **R3** `venue_id`→`project_id` (column + FK constraint per 11 child tables) + rebuild view/trigger fns/policies referencing it. **Fold in SEC-6/SEC-7** (`(select auth.uid())` rewrites + merge duplicate SELECT policies).
- **R4** storage bucket — done in Phase 6.
- **R5** EF slug renames (LAST; manual deploys): `atlas-*`→`enricher-*`/`scheduler-*`, `*-unit*`→`*-project*`, `recommend-deck/catalog`→`swipe/map` (+ `recommender-rank-*`), `invite-waiter`→`invite-staff`, `invite-business`→`invite-member`, `grant-membership`→`grant-plan`. Per EF: rename dir → repoint internal callers (`invokeArtificialCaller` literals + `_shared/internal.ts`) → update web/mobile/n8n literals → `supabase functions deploy <new>` → verify cloud==repo → delete old. Final migration swaps the cron fn's hardcoded EF URL to `scheduler-run-project-creations`.

## Cross-repo sync (same window)
- `mesita-supabase`: all migrations + EF renames.
- web `mesita-web-admin`/`-business`/`-consumer` + Expo mobile: EF slug literals + bucket URLs (B-1, B-2). ~~Mobile still on `consumer-get-venue`/`consumer-list-venues`~~ — superseded 2026-07-04: the mobile repo no longer exists and both venue-slug EFs are on the AUDIT-2026-07-03.md delete runbook.
- `mesita-n8n`: Enricher → `enricher-*` slugs (B-6).
- Notion (Enricher DB, Components DB, Categories DB): reflect enricher/scheduler + project/place terms.
