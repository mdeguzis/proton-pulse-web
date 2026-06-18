-- Tracks flagged reports for admin review.
-- Used for ProtonDB reports (which have no user_configs row) and as a
-- unified log for all flagged reports. Pulse reports also update
-- user_configs.is_flagged so the pipeline excludes them.
CREATE TABLE IF NOT EXISTS flagged_reports (
  id          bigserial PRIMARY KEY,
  app_id      text NOT NULL,
  report_key  text NOT NULL,
  source      text NOT NULL DEFAULT 'unknown',
  flagged_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, report_key)
);

ALTER TABLE flagged_reports ENABLE ROW LEVEL SECURITY;

-- Anyone can insert a flag (community moderation).
CREATE POLICY "Anyone can flag a report"
  ON flagged_reports FOR INSERT
  WITH CHECK (true);

-- Anyone can read flags (needed to show flagged state on page load if desired).
CREATE POLICY "Anyone can read flags"
  ON flagged_reports FOR SELECT
  USING (true);
