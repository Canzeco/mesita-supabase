# Ticket sequences & types

Source of truth for consumer, staff (WhatsApp), and business-console flows.

## Sequences

### Scan

1. Waiter scans QR and sends code to bot.
2. Bot validates code and sends consumer credential to waiter.

### Billing

1. Bot sends the billing form to the waiter.
2. Waiter enters bill total (and tip if cashback).
3. Bot calculates discount/cashback.
4. Bot sends bill to consumer and waiter as passive payment instructions.

### Story

1. Consumer posts IG story tagging Mesita and the venue.
2. ~~Consumer submits story screenshot in the Mesita app~~ (removed).
3. Bot automatically identifies tag and updates ticket state.
4. Bot evaluates story and sends confirmation request to the waiter.
5. Waiter submits form validating the IG story.

### Discount payment

1. Consumer taps **Paid issued**.
2. Waiter taps **Paid received**.

### Cashback payment

1. Bot creates and sends Stripe checkout to the consumer.
2. Consumer pays online from their phone.

### Cashback landing

1. Cashback lands in the consumer's Mesita balance.

### Review

1. Food, service, ambiance, overall.
2. Comments.

## Ticket types

| Type | Flow |
|------|------|
| **A** — Discount, no story | Scan → Billing → Discount payment → Review |
| **B** — Discount, story | Scan → Billing → Story → Discount payment → Review |
| **C** — Cashback, no story | Scan → Billing → Cashback payment → Review → Cashback landing |
| **D** — Cashback, story | Scan → Billing → Story → Cashback payment → Review → Cashback landing |

Pre-scan story fallbacks and post-pay story fallbacks are **not** part of the product (struck from spec).

## Implementation map

| Surface | Module |
|---------|--------|
| Consumer stepper | `mesita-web-consumer/src/lib/ticket-flow-steps.ts` |
| Business floor | `mesita-web-business/src/lib/ticket-staff-lifecycle.ts` |
| Scan-only + bill | `business-create-ticket` (`scanOnly`), `business-submit-ticket-bill` |
| WhatsApp waiter | `supabase/functions/_shared/staff-whatsapp-flow.ts` |
