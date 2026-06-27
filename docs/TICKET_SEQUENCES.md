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

1. Consumer posts IG story tagging Mesita and the place.
2. ~~Consumer submits the story screenshot in the Mesita app~~ (removed).
3. Bot automatically identifies tag and updates ticket state.
4. Bot evaluates the story and sends a confirmation request to the waiter.
5. Waiter submits the form validating the IG story.

### Discount payment sequence

Staff-only confirmation for off-rail (table) discount visits:

1. Consumer sees passive payment instructions in the app (no payment button).
2. Guest pays the discounted total at the table.
3. Waiter taps **Paid received** (business console or WhatsApp **listo**).

Ticket advances to review when staff confirms (`business-mark-ticket-paid` → `revealed`).

### Review sequence

1. Food, service, ambiance, overall.
2. Comments.

Runs on the consumer app after staff payment confirmation.

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

## Implementation map

| Surface | Module |
|---------|--------|
| Consumer stepper | `mesita-web-consumer/src/lib/ticket-flow-steps.ts` |
| Business floor | `mesita-web-business/src/lib/ticket-staff-lifecycle.ts` |
| Scan + bill | `business-create-ticket` (`scanOnly`), `business-submit-ticket-bill` |
| Discount pay | `business-mark-ticket-paid`, staff WhatsApp `handleStaffPaymentConfirm` |
| Story | IG tag detection, `business-verify-story` |
| WhatsApp waiter | `supabase/functions/_shared/staff-whatsapp-flow.ts` |
