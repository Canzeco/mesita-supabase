-- Drop the youtube_url venue channel field.
-- YouTube was removed from the ADEA discovery set and from all web apps
-- (business/consumer/admin) + the Edge Functions in the same change. No view,
-- function, index, or RLS policy references this column.
alter table public.venues drop column if exists youtube_url;
