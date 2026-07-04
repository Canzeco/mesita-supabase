# Billing rollout — 2026-07-04

Business place plans (Promote `pro` $100 MXN/mo, Ultra `ultra` $5,000 MXN/mo)
become real monthly Stripe subscriptions, and consumer Premium drops to
$100 MXN/mo. The repo side is merged; the cloud steps below are blocked by
the auto-mode guard and need a human run — same situation as
`AUDIT-2026-07-03.md` (whose two migrations are still pending and apply
first by version order).

All commands from `mesita-supabase/`:

## 1. Apply migrations

```sh
supabase db push --include-all
```

Applies, in order: `20260703120000_fix_scheduler_cron_name`,
`20260703121000_drop_saved_places_coupons` (both from the audit), then
`20260704090000_business_billing_plans` (business_plans +
project_subscriptions tables, premium reseed at $100, admin reset function
updated).

## 2. Deploy the billing Edge Functions

```sh
supabase functions deploy business-change-subscription \
  stripe-handle-webhook consumer-create-subscription business-update-project \
  --project-ref yjalywfzdelacdzccpgb
```

- `business-change-subscription` — NEW: owner-only Free/Promote/Ultra changes
  (Stripe Checkout in real mode, instant grant in mock mode).
- `stripe-handle-webhook` — now reconciles both consumer and business
  subscriptions (discriminated by `consumer_id` / `project_id` metadata).
- `consumer-create-subscription` — $100 fallback + self-provisioning price.
- `business-update-project` — no longer accepts `plan` (billing owns it).

Must run AFTER step 1 (the EFs read the new tables). Afterwards, verify
cloud == repo via MCP `get_edge_function` (no stubs — see the
atlas-enrich-place incident).

## 3. Go real (optional — currently mocked)

```sh
supabase secrets set MOCK_SUBSCRIPTION=false
```

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
