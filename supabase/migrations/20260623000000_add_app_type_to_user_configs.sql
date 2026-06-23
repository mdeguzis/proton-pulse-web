-- Add app_type to user_configs to distinguish game store/platform.
-- Values: steam (default), gog, epic, nonsteam.
-- Existing rows default to 'steam'; new non-Steam submissions set this explicitly.
-- app_id for non-Steam games uses a prefixed format: gog:<product_id>, epic:<game_id>.

ALTER TABLE public.user_configs
  ADD COLUMN IF NOT EXISTS app_type text NOT NULL DEFAULT 'steam'
    CHECK (app_type IN ('steam', 'gog', 'epic', 'nonsteam'));

-- Mirror in history table so snapshots stay consistent.
ALTER TABLE public.user_configs_history
  ADD COLUMN IF NOT EXISTS app_type text;

-- Index for filtering reports by platform.
CREATE INDEX IF NOT EXISTS idx_user_configs_app_type
  ON public.user_configs (app_type);
