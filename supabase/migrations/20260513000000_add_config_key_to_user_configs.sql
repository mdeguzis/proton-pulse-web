-- Add config_key to user_configs so each submitted report can be linked back
-- to the specific config that was active at time of submission. This allows
-- the website to look up per-report config playtime from config_playtime_totals.
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS config_key TEXT;
