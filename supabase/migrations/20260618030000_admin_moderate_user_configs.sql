-- Let admins moderate report content directly from the admin UI.
--
-- Previously the only write policies on user_configs were owner-scoped
-- ("owner update configs"), and moderation was expected to go through the
-- service role. The admin Flagged Reports flow runs with the admin's own auth
-- session, so it needs UPDATE (shadow ban / release via is_hidden) and DELETE
-- (remove report content) on any row. Admins are rows in public.admins keyed by
-- proton_pulse_user_id = auth.uid(), the same EXISTS check used by the
-- banned_users policies.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_configs'
      AND policyname = 'admins update configs'
  ) THEN
    CREATE POLICY "admins update configs"
      ON public.user_configs FOR UPDATE
      TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_configs'
      AND policyname = 'admins delete configs'
  ) THEN
    CREATE POLICY "admins delete configs"
      ON public.user_configs FOR DELETE
      TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid()));
  END IF;
END $$;
