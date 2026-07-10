-- Phones must ALWAYS carry a country code (MESITA-387).
-- Backfill: prefix +52 onto bare 10-digit national numbers (Mesita is
-- Mexico-only today). Idempotent — rows already starting with "+" are
-- untouched, and re-running matches nothing new.
UPDATE public.places
SET phone = '+52 ' || phone
WHERE phone IS NOT NULL
  AND phone !~ '^\+'
  AND length(regexp_replace(phone, '\D', '', 'g')) = 10;
