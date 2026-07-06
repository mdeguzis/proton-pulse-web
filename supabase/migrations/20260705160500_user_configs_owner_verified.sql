-- Verified-owner flag on individual reports (#199).
--
-- Set to true at submit time only when the reporter's cached Steam library
-- (public.user_steam_library.appids) contains the report's app_id. Renders
-- as a "Verified owner" badge on report cards. Distinct from the legacy
-- game_owned column, which was unconditionally set to true for web
-- submissions and is therefore not an owner attestation.

alter table public.user_configs
  add column if not exists owner_verified boolean not null default false;
