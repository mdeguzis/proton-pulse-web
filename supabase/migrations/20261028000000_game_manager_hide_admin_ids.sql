-- #570: game_hides / game_remaps exposed admin user ids to anonymous reads.
--
-- Both tables have a public SELECT policy ("anyone can read ...") because
-- the frontend filters hidden games and follows remaps without a session.
-- PostgREST returns every column, so hidden_by / remapped_by (auth user
-- ids) were readable by anyone. The public only needs the app ids, the
-- reason and the timestamps.
--
-- 1. hidden_by / remapped_by default to auth.uid(): the server records who
--    acted, and the client stops sending it (so it can't write another
--    admin's id either).
-- 2. Column-level SELECT for anon + authenticated, without the id columns.
-- 3. Column-level INSERT / UPDATE to match. PostgREST's merge-duplicates
--    upsert sets every column the client sends from EXCLUDED, and reading
--    EXCLUDED.hidden_by would need SELECT on it, so the id columns must not
--    be sent at all.
-- RLS policies are unchanged: writes still require manage_games. The
-- service role (pipeline, backups) keeps full access.

ALTER TABLE public.game_hides  ALTER COLUMN hidden_by   SET DEFAULT auth.uid();
ALTER TABLE public.game_remaps ALTER COLUMN remapped_by SET DEFAULT auth.uid();

REVOKE SELECT, INSERT, UPDATE ON public.game_hides FROM anon, authenticated;
GRANT SELECT (app_id, reason, hidden_at) ON public.game_hides TO anon, authenticated;
GRANT INSERT (app_id, reason), UPDATE (app_id, reason) ON public.game_hides TO authenticated;

REVOKE SELECT, INSERT, UPDATE ON public.game_remaps FROM anon, authenticated;
GRANT SELECT (from_app_id, to_app_id, reason, created_at, updated_at) ON public.game_remaps TO anon, authenticated;
GRANT INSERT (from_app_id, to_app_id, reason), UPDATE (from_app_id, to_app_id, reason, updated_at)
  ON public.game_remaps TO authenticated;
