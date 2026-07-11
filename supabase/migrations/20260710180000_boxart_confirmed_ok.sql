-- Admin "reprobe confirmed working" state (#270).
--
-- When an admin runs the Box Art Manager reprobe and the URL loads OK, that
-- fact needs to survive a page reload. Before this table the admin panel
-- painted the row green in-memory but on refresh the appid came back under
-- the "missing" filter because game-images-cache.json (pipeline) and
-- image_load_errors (client telemetry) still listed it.
--
-- Reads are anon (mirrors box_art_overrides). Writes go through the
-- image-refetch edge function, which authenticates the caller.

CREATE TABLE IF NOT EXISTS public.boxart_confirmed_ok (
    app_id          TEXT PRIMARY KEY,
    confirmed_url   TEXT,
    confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.boxart_confirmed_ok ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='boxart_confirmed_ok' AND policyname='anyone can read boxart confirmations') THEN
    CREATE POLICY "anyone can read boxart confirmations" ON public.boxart_confirmed_ok
      FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='boxart_confirmed_ok' AND policyname='admins with manage_box_art can upsert confirmations') THEN
    CREATE POLICY "admins with manage_box_art can upsert confirmations" ON public.boxart_confirmed_ok
      FOR INSERT TO authenticated
      WITH CHECK (public.current_user_has_permission('manage_box_art'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='boxart_confirmed_ok' AND policyname='admins with manage_box_art can update confirmations') THEN
    CREATE POLICY "admins with manage_box_art can update confirmations" ON public.boxart_confirmed_ok
      FOR UPDATE TO authenticated
      USING (public.current_user_has_permission('manage_box_art'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='boxart_confirmed_ok' AND policyname='admins with manage_box_art can clear confirmations') THEN
    CREATE POLICY "admins with manage_box_art can clear confirmations" ON public.boxart_confirmed_ok
      FOR DELETE TO authenticated
      USING (public.current_user_has_permission('manage_box_art'));
  END IF;
END $$;
