# Ticket sequences & types

Source of truth for consumer, staff (WhatsApp), and business-console flows.

## Sequences

### Scan sequence

1. Waiter scans QR and sends the code to bot.
2. Bot validates code and sends consumer credential to waiter.

### Billing sequence

1. Bot sends the billing form to the waiter.
2. Waiter enters bill total (and tip if cashback) into the form.
3. Bot calculates the bill with the discount/cashback applied.
4. Bot sends bill to consumer and waiter as passive payment instructions.

### Story sequence

1. Consumer posts IG story tagging Mesita and the venue.
2. ~~Consumer submits the story screenshot in the Mesita app~~ (removed).
3. Bot automatically identifies tag and updates ticket state.
4. Bot evaluates the story and sends a confirmation request to the waiter.
5. Waiter submits the form validating the IG story.

### Discount payment sequence

Dual attestation for off-rail (table) discount visits:

1. Consumer taps **Paid issued**.
2. Waiter taps **Paid received**.

Ticket advances to review only when both timestamps are set (`consumer_payment_confirmed_at`, `staff_payment_confirmed_at`).

### Cashback payment sequence

1. Bot creates and sends a Stripe checkout to the consumer.
2. Consumer pays online from their phone.

No waiter payment confirmation — Stripe (or `business-mark-paid` in mock) is the source of truth.

### Cashback landing sequence

1. Cashback lands into the consumer's Mesita balance.

### Review sequence

1. Food, service, ambiance, overall.
2. Comments.

Runs on the consumer app after payment (and before cashback landing on types C/D).

## Ticket types

### Type A — Discount, no story

1. Scan sequence
2. Billing sequence
3. Discount payment sequence
4. Review sequence

Kinds: `dp`, `r_dp`.

### Type B — Discount, with story

1. ~~Story sequence (fallback)~~ — not in product
2. Scan sequence
3. Billing sequence
4. Story sequence
5. Discount payment sequence
6. Review sequence
7. ~~Story sequence (fallback, vulnerability)~~ — not in product

Kinds: `s_dp_sf`, `r_s_dp_sf`. Story runs **after** billing, before discount payment.

### Type C — Cashback, no story

1. Scan sequence
2. Billing sequence
3. Cashback payment sequence
4. Review sequence
5. Cashback landing sequence

Kinds: `p_c`, `r_p_c`.

### Type D — Cashback, with story

1. ~~Story sequence~~ — not in product (no pre-scan story gate)
2. Scan sequence
3. Billing sequence
4. Story sequence — post-billing verification (doc label: fallback; same step as B, different mechanic)
5. Cashback payment sequence
6. ~~Story sequence (fallback)~~ — not in product (no post-pay story gate)
7. Review sequence
8. Cashback landing sequence

Kinds: `s_p_sf_c`, `r_s_p_sf_c`. Story runs **after** billing, before Stripe pay.

## Implementation map

| Surface | Module |
|---------|--------|
| Consumer stepper | `mesita-web-consumer/src/lib/ticket-flow-steps.ts` |
| Business floor | `mesita-web-business/src/lib/ticket-staff-lifecycle.ts` |
| Scan + bill | `business-create-ticket` (`scanOnly`), `business-submit-ticket-bill` |
| Discount pay | `consumer-confirm-ticket-payment`, staff WhatsApp `handleStaffPaymentConfirm` |
| Formal pay | Stripe checkout + `business-mark-paid` / webhook |
| Story | IG tag detection, `business-verify-story` |
| WhatsApp waiter | `supabase/functions/_shared/staff-whatsapp-flow.ts` |
