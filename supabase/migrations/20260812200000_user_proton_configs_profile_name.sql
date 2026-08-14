-- Multi-config-per-app: user_proton_configs now supports multiple named
-- profiles per (voter_id, app_id). Adds a profile_name column, backfills
-- it from the existing config->>'profileName' blob (or 'Default' when the
-- blob has no profile name), and switches the primary key from
-- (voter_id, app_id) to (voter_id, app_id, profile_name).
--
-- Old plugin builds pushed without a profile_name column at all -- their
-- rows still work: the backfill drops them into the 'Default' slot, and a
-- newer plugin push with the same profile_name upserts the same row via
-- the new on_conflict target.
--
-- Idempotent: uses IF NOT EXISTS on the column, guards the PK swap on the
-- current constraint name, and re-runs the backfill safely.

-- 1. Add the column with a placeholder default so no row is ever NULL.
alter table public.user_proton_configs
  add column if not exists profile_name text not null default 'Default';

-- 2. Backfill from the config blob for any pre-existing rows. Trim first --
--    a config with profileName = '' should still land in 'Default', not in
--    a whitespace slot no one can address.
update public.user_proton_configs
   set profile_name = nullif(trim(config->>'profileName'), '')
 where nullif(trim(config->>'profileName'), '') is not null
   and profile_name = 'Default';

-- 3. Swap the primary key. The old PK is (voter_id, app_id); the new one
--    adds profile_name so two rows with different profiles coexist. Do it
--    in one alter so there is no window without a PK.
do $$
declare
  old_pk text;
begin
  select conname
    into old_pk
    from pg_constraint
   where conrelid = 'public.user_proton_configs'::regclass
     and contype = 'p';
  if old_pk is not null and old_pk <> 'user_proton_configs_pk_v2' then
    execute format('alter table public.user_proton_configs drop constraint %I', old_pk);
    alter table public.user_proton_configs
      add constraint user_proton_configs_pk_v2 primary key (voter_id, app_id, profile_name);
  end if;
end
$$;
