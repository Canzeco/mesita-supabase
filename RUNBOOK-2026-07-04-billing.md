# Billing rollout — 2026-07-04

Business place plans (Promote `pro` $100 MXN/mo, Ultra `ultra` $5,000 MXN/mo)
become real monthly Stripe subscriptions, and consumer Premium drops to
$100 MXN/mo. The repo side is on this branch; the cloud steps below are
blocked by the auto-mode guard and need a human run.

> **STATUS 2026-07-04 (MESITA-33): steps 1–2 EXECUTED and verified.** Step 3
> (`MOCK_SUBSCRIPTION=false`) is NOT run — it is Pato's go-live trigger
> (MESITA-37). See "Execution log" at the bottom for what actually ran,
> including the migration-ledger repair the push required.

(The 2026-07-03 audit has since landed on main — cron fix applied, dead cloud
EFs deleted, and the saved_places/coupons drop was withdrawn, so those tables
stay. This migration's `admin_reset_database` keeps them in the truncate list.)

All commands from `mesita-supabase/`:

## 1. Apply migrations — EXECUTED 2026-07-04

```sh
supabase db push --include-all
```

Applies `20260704090000_business_billing_plans` (business_plans +
project_subscriptions tables, premium reseed at $100, admin_reset_database
updated to add project_subscriptions while keeping coupons/saved_places).

## 2. Deploy the billing Edge Functions — EXECUTED 2026-07-04

```sh
supabase functions deploy business-change-subscription \
  stripe-handle-webhook consumer-create-subscription business-update-project \
  twilio-whatsapp-inbound \
  --project-ref yjalywfzdelacdzccpgb
```

- `business-change-subscription` — NEW: owner-only Free/Promote/Ultra changes
  (Stripe Checkout in real mode, instant grant in mock mode).
- `stripe-handle-webhook` — now reconciles both consumer and business
  subscriptions (discriminated by `consumer_id` / `project_id` metadata);
  retires prior live rows before mirroring (one-live invariant) and rolls
  back the dedupe marker on handler error so failed events retry.
- `consumer-create-subscription` — $100 fallback + self-provisioning price.
- `business-update-project` — no longer accepts `plan` (billing owns it).
- `twilio-whatsapp-inbound` — bundles the `_shared/staff-place-ops.ts` fix:
  its discount-eligibility gate now recognises the `pro`/`ultra` plan keys
  (was still checking the retired `informal_pro`/`informal_ultra`, which
  blocked every paid place from opening a discount ticket over WhatsApp).

Must run AFTER step 1 (the EFs read the new tables). Afterwards, verify
cloud == repo via MCP `get_edge_function` (no stubs — see the
atlas-enrich-place incident).

## 3. Go real (optional — currently mocked) — **NOT RUN: Pato's go-live trigger (MESITA-37)**

```sh
supabase secrets set MOCK_SUBSCRIPTION=false
```

**Deliberately left for Pato.** Agents must never flip `MOCK_SUBSCRIPTION` or
run `supabase secrets set`; this step goes live only when Pato triggers
MESITA-37.

With mock off, the FIRST real checkout self-provisions the whole Stripe
catalog in whatever account `STRIPE_SECRET_KEY` points at — three products
with monthly MXN prices under lookup keys `consumer_premium_monthly`,
`business_pro_monthly`, `business_ultra_monthly` — and caches the price ids
into `plans.stripe_price_id` / `business_plans.stripe_price_id`. A stale
cached price (e.g. the old $200 Premium) is detected by amount mismatch,
replaced, and deactivated automatically. No Stripe dashboard step.

Note: the webhook endpoint + `STRIPE_WEBHOOK_SECRET` must belong to the same
Stripe account as `STRIPE_SECRET_KEY` (already true for the live consumer
flow; business events reuse the same endpoint). The consumer subscribe page
also has a client-side `MOCK_SUBSCRIPTION` const
(`mesita-web-consumer/src/app/(shell)/subscribe/[tier]/page.tsx`) that must
be flipped to `false` to exercise the real consumer checkout.

## Already done directly in cloud (data-only, same session)

- `plans.premium.price_cents` 20000 → 10000 (mirrored in the migration's
  upsert, so a reset keeps it).

## Follow-ups

- Regenerate `database.types.ts` in the web repos after the migration lands
  (their `membership` enum literals predate the r1 rename; currently unused).

## Execution log — 2026-07-04 (MESITA-33)

Steps 1–2 were run by agent lane A. The push did NOT apply cleanly as
written: the cloud `supabase_migrations.schema_migrations` ledger had
diverged from the repo (stale pre-rename version stamps left over from the
2026-07-03 audit's manual reconciliation), so `db push` first reported a
migration-history mismatch. Required preamble before the push:

```sh
# 1. Un-record 11 stale cloud-only version stamps (DDL itself was already live)
supabase migration repair --status reverted \
  20260625055959 20260625081943 20260625101502 20260625105858 \
  20260625184612 20260625192057 20260625203303 20260625210358 \
  20260626122445 20260626160236 20260626161010

# 2. Record the 25 repo migrations whose DDL was already applied in cloud
supabase migration repair --status applied \
  20260625060037 20260625070000 20260625080000 20260625090000 \
  20260625120000 20260625140000 20260625150000 20260625160000 \
  20260625161000 20260625170000 20260626120000 20260626140000 \
  20260626162000 20260626170000 20260626180000 20260626190000 \
  20260626200000 20260626210000 20260626211000 20260626220000 \
  20260626230000 20260626240000 20260626250000 20260626260000 \
  20260626270000
```

Preconditions were verified read-only before the repair (places.yelp_url,
place_tags, project_members.project_id, pg_net all present; business_plans /
project_subscriptions absent; plans.premium already 10000). A `--dry-run`
confirmed the push would apply only `20260704090000_business_billing_plans`,
then the real push applied it.

Post-run verification (MCP, 2026-07-04):

- `business_plans` + `project_subscriptions` exist; seeded `pro` = 10000,
  `ultra` = 500000 (free has no row by design); `plans.premium` = 10000;
  `20260704090000` recorded in the ledger.
- All 5 EFs redeployed in one batch (shared fresh `updated_at`):
  `business-change-subscription` v1 (new), `stripe-handle-webhook` v49
  (`verify_jwt=false` preserved), `consumer-create-subscription` v49,
  `business-update-project` v3, `twilio-whatsapp-inbound` v69
  (`verify_jwt=false` preserved). No stubs — bundles uploaded from repo
  sources including `_shared/stripe-billing.ts` / `staff-place-ops.ts`.

Step 3 remains open — Pato's go-live trigger (MESITA-37).
