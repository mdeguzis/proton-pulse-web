-- Align user_proton_configs.app_id with user_configs.app_id.
--
-- user_configs.app_id is text but user_proton_configs.app_id is bigint. The API
-- therefore returns one as a string and the other as a number, so the My Reports
-- merge (mergeMyReportRows) saw a game with both a published report and a cloud
-- config as two separate rows. Issue #131 normalized the merge key in JS as the
-- immediate fix; this migration aligns the column types so both sources return
-- the same shape and the data model is consistent.
--
-- text is the canonical choice: it matches the reports table and is future proof
-- for large non-Steam (GOG / Epic / Steam shortcut) ids that can exceed a signed
-- bigint. Casting bigint to text never loses data.
--
-- Postgres rebuilds the dependent unique index on (voter_id, app_id)
-- automatically when the column type changes, so no constraint drop is needed.
--
-- IMPORTANT: deploy the plugin fix that compares app_id with String() (plugin
-- issue #95) to a stable release before applying this. Plugins built before that
-- fix compare app_id to a numeric appId and will fail restore-one and
-- publish-state lookups once the column returns strings.

alter table public.user_proton_configs
  alter column app_id type text using app_id::text;
