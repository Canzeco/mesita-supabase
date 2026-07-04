-- Drop the rappi_url venue channel field. Delivery is Uber Eats only.
alter table public.venues drop column if exists rappi_url;
