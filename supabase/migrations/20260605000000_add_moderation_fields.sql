-- Add moderation columns to user_configs and restrict public reads to non-hidden rows.

ALTER TABLE public.user_configs
  ADD COLUMN IF NOT EXISTS is_flagged   boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_hidden    boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flagged_reason text,
  ADD COLUMN IF NOT EXISTS flagged_at   timestamptz;

CREATE INDEX IF NOT EXISTS idx_user_configs_is_flagged
  ON public.user_configs (is_flagged)
  WHERE is_flagged = true;

CREATE INDEX IF NOT EXISTS idx_user_configs_is_hidden
  ON public.user_configs (is_hidden)
  WHERE is_hidden = true;

-- Enable RLS if not already active (idempotent: enabling twice is a no-op in Postgres).
ALTER TABLE public.user_configs ENABLE ROW LEVEL SECURITY;

-- Public SELECT: anon and authenticated users see all non-hidden rows,
-- plus their own rows regardless of hidden status.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'user_configs'
      AND policyname = 'public read non-hidden configs'
  ) THEN
    CREATE POLICY "public read non-hidden configs"
      ON public.user_configs FOR SELECT
      USING (
        is_hidden = false
        OR proton_pulse_user_id = auth.uid()
      );
  END IF;
END $$;

-- Allow anon to INSERT (unchanged from implicit open access before RLS was enabled).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'user_configs'
      AND policyname = 'public insert configs'
  ) THEN
    CREATE POLICY "public insert configs"
      ON public.user_configs FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;

-- Allow authenticated owners to UPDATE their own rows (needed for future self-edit flows).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'user_configs'
      AND policyname = 'owner update configs'
  ) THEN
    CREATE POLICY "owner update configs"
      ON public.user_configs FOR UPDATE
      USING (proton_pulse_user_id = auth.uid());
  END IF;
END $$;

-- Service role bypasses RLS automatically, so the moderation workflow
-- can read and update any row without a separate policy.
