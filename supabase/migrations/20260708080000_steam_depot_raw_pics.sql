-- #237: capture the full parsed PICS depots block per app.
--
-- steam_depot_updates holds the narrow columns the metadata modal needs
-- (app_id, depot_id, os, manifest_id, last_updated_at). PICS gives us
-- more than that -- shared install flags, encryptedmanifests, dlc_appids,
-- config.installscripts, branch buildids, etc.
--
-- Rather than schema-thrash for each new field, persist the raw parsed
-- depots dict as a JSONB blob on the existing fetch_status row (already
-- one per app). Cheap to store (~2 KB per game) and the pipeline can
-- read it back later without another PICS round-trip.
--
-- The frontend never reads this column directly. It flows out via the
-- write_depot_files pipeline step -> data/{shard}/{appId}/depots.json
-- so the Metadata modal can deep-link to it.

alter table public.steam_depot_fetch_status
  add column if not exists raw_pics jsonb;

-- No index needed -- this column is read app-by-app during finalize,
-- never in a scan. Public read stays intact.

comment on column public.steam_depot_fetch_status.raw_pics is
  'Full parsed PICS depots dict from steamcmd app_info_print. Includes '
  'every field steamcmd emitted (config.oslist, manifests.public.*, '
  'branches.public.*, sharedinstall, dlc_appids, ...). #237.';
