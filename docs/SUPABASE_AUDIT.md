# Mesita — Supabase Audit & Minimization (2026-06-26, v2)

> **Superseded in part by [`AUDIT-2026-07-03.md`](../AUDIT-2026-07-03.md)** (usage audit, EF prune
> rounds 1–5). Where the two disagree, the 2026-07-03 doc wins.

Project `yjalywfzdelacdzccpgb` · PostgreSQL 17 · EF-only data access · refreshed after Track B (async create→enrich + n8n Enricher) and the audit-driven minimization.

> This supersedes the v1 PDF audit. The PDF's counts were partly stale (it listed **11** extensions; only **9** are installed — no `pgsodium`/`pg_graphql`).

## Inventory: baseline → now → target

| Entity | v1 baseline | post-Track-B | after minimization | net |
|---|---|---|---|---|
| Tables | 28 | 28 | **26** | −2 (`bench_*`) |
| Edge Functions | 75 | 74 | **71** | −3 dead (kept 3 real orphans) |
| DB functions (public) | 20 | 19 | **14** | −5 |
| Triggers (public) | 15 | 16 | 16 | 0 (1 repointed) |
| Enums | 14 | 14 | 14 | 0 types (values collapsed) |
| Indexes (public) | ~85 | 89 | **86** | −3 |
| Extensions (installed) | "11" (wrong) | 9 | **7** | −2 (`uuid-ossp`,`http`) |
| Publications | 2 | 2 | 2 | 0 (already compliant) |
| Cron jobs | 2 | 2 | 2 | 0 |
| Storage buckets | 1 (`venue-images`) | 1 | 1 (→`place-images`) | rename |

## What changed (DONE — apply-ready migrations on this branch)

**Phase 0 — kill dead** (`20260626190000`): dropped `bench_results` + `bench_restaurants` (ADEA fixtures, 0 refs); deleted EFs `atlas-enrich-event` (501 stub), `admin-schedule-unit-creation` (superseded by `-multiple-units-`), `consumer-confirm-ticket-payment` (empty); removed 8 stale `config.toml` blocks.

**Phase 1 — functions/triggers** (`20260626200000`): dropped `tg_set_updated_at` (dup of `set_updated_at`, repointed its one trigger), folded `format_consumer_code` into `generate_consumer_code`, dropped `format_consumer_code`/`normalize_consumer_code_input`/`jwt_role`/`generate_invite_token` (0 callers; EFs use TS equivalents).

**Phase 2 — extensions** (`20260626210000` + `211000`): dropped `uuid-ossp` + `http` (0 callers); `pg_net`→`extensions` schema as a separate scheduler-sensitive migration (verify poller after).

**Phase 3 — indexes** (`20260626220000`): dropped 3 structurally-redundant indexes (`business_invites_token_idx`, `staff_invites_token_idx`, `consumer_subscriptions_consumer_idx`).

**Phase 4 — RLS hardening** (`20260626230000`): revoked `find_user_id_by_phone` + `venues_view_*` EXECUTE from PUBLIC/anon/authenticated (SEC-1/SEC-2 HIGH); granted phone lookup to `service_role`.

## Kept deliberately (flagged, not cruft)
- ~~EFs `admin-enrich-place`, `admin-grant-membership`, `business-find-consumer`~~ — superseded: the 2026-07-03 audit permanently deleted admin-enrich-place and business-find-consumer and put admin-grant-membership on the cloud delete list.
- All 11 RLS-on/no-policy tables — intentional deny-all (service-role/EF-only); **not** false-negatives.
- `supabase_realtime` publication streams only `consumer_pay_notifications`, which is FK-bound to a ticket → rule-compliant (a ticket stream, not a notifications bus). Unchanged.

## Security / RLS findings

| ID | Finding | Sev | Status |
|---|---|---|---|
| SEC-1 | `find_user_id_by_phone` callable by anon (phone enumeration) | HIGH | ✅ fixed (Phase 4) |
| SEC-2 | `venues_view_*` writers callable by anon/authenticated | HIGH | ✅ fixed (Phase 4) |
| SEC-3 | `tg_set_updated_at` mutable search_path | MED | ✅ fixed (dropped, Phase 1) |
| SEC-4 | `pg_net` in `public` schema | MED | ✅ migration ready (`211000`, verify scheduler) |
| SEC-5 | leaked-password protection off | MED | ⏳ MANUAL: Dashboard → Auth → Password |
| SEC-6 | 18 policies re-eval `auth.uid()` per row | LOW(perf) | ⏳ folded into rename R3 |
| SEC-7 | 3 tables w/ duplicate permissive SELECT policies | LOW(perf) | ⏳ folded into rename R3 |
| SEC-8 | 18 unindexed FKs | INFO | optional, post-launch |

## Pending — coordinated release (Phases 5–7)

These change data semantics / names and **break web + mobile + n8n clients**, so they require a lockstep release window (DB + EF deploys + web/mobile/n8n + Notion). See `docs/RENAME_RUNBOOK.md`.

- **Phase 5 — enum collapses**: `member_role` drop legacy `staff`; `ticket_kind` 9→`reservation`/`coupon`; `venue_plan` 5→`free`/`pro`/`ultra` (→ rename type `membership`); value renames `story_status` `waiter_*`→`staff_*`, `ticket_status` `pending_pay`→`pending_payment`.
- **Phase 6 — storage**: `venue-images` → `place-images` (2639 objects; update `venue_media_assets` URLs + `IMAGE_BUCKET` const + reset-fn preserve invariant).
- **Phase 7 — full nomenclature rename (R0→R5)**: constraints/indexes → `places_*`/`business_invites_*`; enum type renames; tables `units`→`projects` + `venue_*`→`project_*`/`place_*`, `membership_tiers`→`plans`; `venue_id`→`project_id` across 11 tables; view `venues`→`projects_view`; DB fns `seed_venue_*`→`seed_place_*` etc.; EF slugs `atlas-*`→`enricher-*`/`scheduler-*`, `*-unit`→`*-project`, `deck/catalog`→`swipe/map`, `waiter`→`staff`, `grant-membership`→`grant-plan`, `invite-business`→`invite-member`.

## Apply runbook (prod apply is user-run / guarded)

```bash
cd /Users/pato/Desktop/Canzeco/Mesita/mesita-supabase
# Phases 0–4 — paste each migration's SQL into the Supabase SQL editor in order
# (migration histories have diverged from `supabase db push`, so apply by hand):
#   20260626190000_drop_dead_bench_tables.sql
#   20260626200000_minimize_functions.sql
#   20260626210000_minimize_extensions.sql
#   20260626211000_move_pg_net_schema.sql      (then re-run the poller, check net._http_response)
#   20260626220000_minimize_indexes.sql
#   20260626230000_rls_hardening.sql
# Then delete the dead cloud EFs:
supabase functions delete atlas-enrich-event --project-ref yjalywfzdelacdzccpgb
supabase functions delete admin-schedule-unit-creation --project-ref yjalywfzdelacdzccpgb
# Track B EF deploys + the 2 Track B migrations (undefined category, reset truncate) — see Track B PR #129.
# Manual: Dashboard → Auth → enable leaked-password protection (SEC-5).
```
