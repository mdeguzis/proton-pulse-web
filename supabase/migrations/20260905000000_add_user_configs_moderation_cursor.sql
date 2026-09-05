-- #257: track when a user_configs row was last actually scanned by the
-- content moderation job. NULL means "never scanned". The scheduled scans
-- filter on created_at/updated_at within a lookback window, so a row that
-- landed during a scanner outage or otherwise fell outside every window
-- was silently skipped forever with no way to detect it. Selecting on
-- last_moderated_at IS NULL closes that gap regardless of window size.

ALTER TABLE public.user_configs
  ADD COLUMN IF NOT EXISTS last_moderated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_user_configs_last_moderated_at
  ON public.user_configs (last_moderated_at)
  WHERE last_moderated_at IS NULL;
