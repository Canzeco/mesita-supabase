-- One unclaimed staff_invite per venue + phone. Resend refreshes the same row.

-- Normalize stored phones to E.164 before dedupe / unique index.
update public.staff_invites
set phone = '+' || regexp_replace(phone, '[^0-9]', '', 'g')
where phone is not null
  and phone !~ '^\+';

update public.staff_invites
set phone = regexp_replace(phone, '[^0-9+]', '', 'g')
where phone is not null
  and phone ~ '^\+';

-- Drop duplicate pending rows (keep newest per venue + phone).
with ranked as (
  select
    id,
    row_number() over (
      partition by venue_id, phone
      order by created_at desc
    ) as rn
  from public.staff_invites
  where claimed_at is null
    and phone is not null
)
delete from public.staff_invites si
using ranked r
where si.id = r.id
  and r.rn > 1;

create unique index if not exists staff_invites_one_pending_phone_per_venue
  on public.staff_invites (venue_id, phone)
  where claimed_at is null
    and phone is not null;
