-- Add the "value" rating dimension to ticket reviews.
--
-- Consumers now rate Value alongside Food, Service, and Ambiance (with
-- Overall as the headline). Nullable + checked so existing review rows
-- stay valid without a backfill; new reviews from the app always send 1-5.
--
-- admin_reset_database() only truncates ticket_reviews, so it needs no
-- change here — a clean reset still yields a valid empty table.

alter table public.ticket_reviews
  add column if not exists value smallint
  check (value is null or value between 1 and 5);
