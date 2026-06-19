-- Tighten the admin moderation policies on user_configs to respect granular
-- permissions, and let moderators read hidden rows.
--
-- 20260618030000 granted UPDATE/DELETE to anyone in `admins`, but the model has
-- `manage_reports` and `delete_reports`. Since RLS policies are ORed, the broad
-- check let a custom admin without those permissions moderate via REST. Replace
-- the broad checks with current_user_has_permission().
--
-- Also: once a Pulse report is shadow-banned (is_hidden = true), the public read
-- policy hides it from admins who do not own it, so the un-shadow-ban flow could
-- not resolve the row. Add a SELECT policy so moderators can read every row.

DROP POLICY IF EXISTS "admins update configs" ON public.user_configs;
DROP POLICY IF EXISTS "admins delete configs" ON public.user_configs;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_configs' AND policyname='moderators read all configs') THEN
    CREATE POLICY "moderators read all configs"
      ON public.user_configs FOR SELECT
      TO authenticated
      USING (public.current_user_has_permission('manage_reports'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_configs' AND policyname='moderators update configs') THEN
    CREATE POLICY "moderators update configs"
      ON public.user_configs FOR UPDATE
      TO authenticated
      USING (public.current_user_has_permission('manage_reports'))
      WITH CHECK (public.current_user_has_permission('manage_reports'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_configs' AND policyname='moderators delete configs') THEN
    CREATE POLICY "moderators delete configs"
      ON public.user_configs FOR DELETE
      TO authenticated
      USING (public.current_user_has_permission('delete_reports'));
  END IF;
END $$;
