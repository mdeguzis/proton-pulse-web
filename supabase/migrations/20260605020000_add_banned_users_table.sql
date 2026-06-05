-- Tracks banned users. Admins can insert/delete. Public has no access.

CREATE TABLE IF NOT EXISTS public.banned_users (
  id                   bigserial PRIMARY KEY,
  proton_pulse_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  client_id            text,
  steam_username       text,
  banned_reason        text,
  banned_at            timestamptz NOT NULL DEFAULT now(),
  banned_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT banned_users_has_identity CHECK (
    proton_pulse_user_id IS NOT NULL OR client_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_banned_users_user_id
  ON public.banned_users (proton_pulse_user_id)
  WHERE proton_pulse_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_banned_users_client_id
  ON public.banned_users (client_id)
  WHERE client_id IS NOT NULL;

ALTER TABLE public.banned_users ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'banned_users' AND policyname = 'admins manage banned users'
  ) THEN
    CREATE POLICY "admins manage banned users"
      ON public.banned_users FOR ALL
      USING (EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid()));
  END IF;
END $$;

-- Hide reports from banned authenticated users at the RLS layer.
-- This works alongside the existing is_hidden column (either check blocks the row).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_configs' AND policyname = 'hide banned user configs'
  ) THEN
    CREATE POLICY "hide banned user configs"
      ON public.user_configs FOR SELECT
      USING (
        NOT EXISTS (
          SELECT 1 FROM public.banned_users bu
          WHERE bu.proton_pulse_user_id = user_configs.proton_pulse_user_id
             OR bu.client_id = user_configs.client_id
        )
        OR EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid())
      );
  END IF;
END $$;
