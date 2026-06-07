-- Collapse the discount-payment step into billing (reward ticket Design 3).
--
-- Mesita never touches money, so the dual "paid issued / paid received"
-- handshake was ceremony. A reward ticket now closes the moment the bill is
-- issued (Type A) or the story is verified (Type B):
--
--   Type A (no story):  open -> (bill) -> revealed
--   Type B (with story): open -> (bill) -> awaiting_story -> (story) -> revealed
--
-- The two payment-confirmation timestamps are removed. The ticket_status enum
-- keeps its now-dormant values ('awaiting_payment_confirm', 'pending_pay',
-- 'paid') because Postgres can't drop enum values in place; nothing writes them
-- anymore. The consumer inbox 'payment_confirm' kind is renamed to 'bill' since
-- it now only delivers the receipt, not a payment action.

-- 1. Drop the payment-confirmation columns.
alter table public.tickets drop column if exists consumer_payment_confirmed_at;
alter table public.tickets drop column if exists staff_payment_confirmed_at;

-- 2. Move any in-flight tickets to the new terminal/awaiting-story states.
update public.tickets
set status = 'awaiting_story'
where status in ('awaiting_payment_confirm', 'pending_pay', 'paid')
  and story_status in ('pending', 'submitted', 'ai_rejected', 'waiter_rejected');

update public.tickets
set status = 'revealed',
    revealed_at = coalesce(revealed_at, now()),
    paid_at = coalesce(paid_at, now())
where status in ('awaiting_payment_confirm', 'pending_pay', 'paid');

-- 3. Rename the consumer inbox 'payment_confirm' kind to 'bill'.
alter table public.consumer_pay_notifications
  drop constraint if exists consumer_pay_notifications_kind_check;

update public.consumer_pay_notifications
set kind = 'bill'
where kind = 'payment_confirm';

alter table public.consumer_pay_notifications
  add constraint consumer_pay_notifications_kind_check
  check (kind in ('bill', 'review'));

notify pgrst, 'reload schema';
