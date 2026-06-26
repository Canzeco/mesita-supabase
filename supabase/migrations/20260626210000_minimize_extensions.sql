-- Phase 2 (minimize extensions): 9 → 7 installed extensions.
--
-- Drops two unused extensions. Both DROPs are no-CASCADE (self-protecting: if a
-- dependent object existed the statement errors instead of silently breaking it).
--   • uuid-ossp — 0 callers; gen_random_uuid() (pgcrypto) is the only UUID source.
--   • http      — 0 callers; all outbound HTTP goes through pg_net (net.http_post).
-- (pg_net's relocation out of the public schema is a separate, scheduler-sensitive
--  migration — see 20260626211000_move_pg_net_schema.sql.)

drop extension if exists "uuid-ossp";
drop extension if exists http;
