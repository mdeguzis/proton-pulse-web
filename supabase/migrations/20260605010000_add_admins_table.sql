-- Admins table. Seeded with the project owner (ProfessorKaos64).
-- Service role manages rows; admins can read their own entry to confirm status.

CREATE TABLE IF NOT EXISTS public.admins (
  proton_pulse_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  steam_username       text NOT NULL,
  added_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;

-- Admins can check if they are an admin (needed for frontend gating).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admins' AND policyname = 'admins read own row'
  ) THEN
    CREATE POLICY "admins read own row"
      ON public.admins FOR SELECT
      USING (proton_pulse_user_id = auth.uid());
  END IF;
END $$;

-- Seed: ProfessorKaos64
INSERT INTO public.admins (proton_pulse_user_id, steam_username)
VALUES ('b66fa63b-e86e-4460-b595-1199c4330445', 'ProfessorKaos64')
ON CONFLICT DO NOTHING;

-- Allow admins to SELECT hidden/flagged user_configs rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_configs' AND policyname = 'admins read all configs'
  ) THEN
    CREATE POLICY "admins read all configs"
      ON public.user_configs FOR SELECT
      USING (
        EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid())
      );
  END IF;
END $$;

-- Allow admins to UPDATE moderation fields on any user_configs row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_configs' AND policyname = 'admins update any config'
  ) THEN
    CREATE POLICY "admins update any config"
      ON public.user_configs FOR UPDATE
      USING (
        EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid())
      );
  END IF;
END $$;

-- Allow admins to DELETE any user_configs row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_configs' AND policyname = 'admins delete any config'
  ) THEN
    CREATE POLICY "admins delete any config"
      ON public.user_configs FOR DELETE
      USING (
        EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid())
      );
  END IF;
END $$;
