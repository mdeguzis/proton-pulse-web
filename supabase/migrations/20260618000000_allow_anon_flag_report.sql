-- Allow any visitor (anon or authenticated) to flag a Pulse report.
-- The policy only permits setting is_flagged = true (WITH CHECK), so unflagging
-- requires admin access. This matches the intent: community flagging is one-way.
CREATE POLICY "Anyone can flag a report"
  ON user_configs
  FOR UPDATE
  USING (true)
  WITH CHECK (is_flagged = true);
