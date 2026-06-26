-- Phase 1 (minimize DB functions/triggers): 19 → 14 public functions.
--
-- Drops 4 unused helpers + the duplicate updated_at stamper, and folds
-- format_consumer_code's lpad expression into generate_consumer_code so the
-- single-statement counter bump stays the one place consumer codes are made.
-- All four dropped helpers have 0 RLS-policy / DB-function / EF-RPC callers
-- (verified); the EF layer uses TS equivalents (_shared/tokens.ts for invite
-- tokens, _shared/auth.ts for the JWT role claim). DROP ... (no CASCADE) is
-- self-protecting: if any dependency existed it would error rather than break it.

-- 1) Repoint the lone consumer of the duplicate stamper to the canonical
--    set_updated_at (which pins search_path), then drop the dup (resolves the
--    mutable-search_path lint on tg_set_updated_at).
drop trigger if exists set_venue_media_assets_updated_at on public.venue_media_assets;
create trigger venue_media_assets_set_updated_at
  before update on public.venue_media_assets
  for each row execute function public.set_updated_at();
drop function if exists public.tg_set_updated_at();

-- 2) Fold format_consumer_code into generate_consumer_code (inline lpad).
create or replace function public.generate_consumer_code()
 returns text
 language plpgsql
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  seq bigint;
  formatted text;
begin
  update public.consumer_code_counter
  set next_value = next_value + 1
  where id = 1
  returning next_value - 1 into seq;

  if seq is null then
    raise exception 'consumer_code_counter missing';
  end if;
  if seq > 99999999 then
    raise exception 'consumer code space exhausted';
  end if;

  formatted := lpad((seq / 10000)::text, 4, '0') || '-' || lpad((mod(seq, 10000))::text, 4, '0');
  if exists (select 1 from public.consumers where code = formatted) then
    raise exception 'consumer code collision at %', formatted;
  end if;
  return formatted;
end;
$function$;

-- 3) Drop the now-unused helpers.
drop function if exists public.format_consumer_code(bigint);
drop function if exists public.normalize_consumer_code_input(text);
drop function if exists public.jwt_role();
drop function if exists public.generate_invite_token();

notify pgrst, 'reload schema';
