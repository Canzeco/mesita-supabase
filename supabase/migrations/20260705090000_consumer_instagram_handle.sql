-- MESITA-74: store the claimed Instagram handle on the consumer.
-- consumer-web-claim-instagram already accepted `handle` in its body but had
-- nowhere to put it; the profile hero/settings want to show @handle instead
-- of just the follower count. Normalized lowercase, no leading @.

alter table public.consumers
  add column if not exists instagram_handle text
    check (instagram_handle ~ '^[a-z0-9._]{1,30}$');
