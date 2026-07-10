-- #234: Admin Game Manager tables.
--
-- Two admin-curated tables that let a moderator hide a bogus game or
-- remap a stale/incorrect app id to the correct one. Both are the
-- manual fallback for cases the pipeline validator (#233) can't handle.
--
-- game_hides:  app_id blacklist. Pipeline + frontend can filter these
--              rows out of search-index and per-app fetches. Admin sets
--              a free-text `reason` so the paper trail explains why.
-- game_remaps: from_app_id -> to_app_id. A stronger form of #27's
--              `replaced_by` detection: admins overrule the pipeline's
--              guess when Steam's own redirects are wrong (or missing).
--
-- Both keyed on app_id TEXT so they support the same store-prefixed
-- ids the rest of the site does (`gog:123`, `epic:MyGame`, etc.).

-- ── game_hides ──
CREATE TABLE IF NOT EXISTS public.game_hides (
  app_id      TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  hidden_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.game_hides ENABLE ROW LEVEL SECURITY;

-- Public read: the pipeline needs to enforce hides at build time and
-- the frontend may also filter on the fly.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='game_hides' AND policyname='anyone can read game_hides') THEN
    CREATE POLICY "anyone can read game_hides" ON public.game_hides
      FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='game_hides' AND policyname='admins with manage_games can insert') THEN
    CREATE POLICY "admins with manage_games can insert" ON public.game_hides
      FOR INSERT TO authenticated
      WITH CHECK (public.current_user_has_permission('manage_games'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='game_hides' AND policyname='admins with manage_games can update') THEN
    CREATE POLICY "admins with manage_games can update" ON public.game_hides
      FOR UPDATE TO authenticated
      USING (public.current_user_has_permission('manage_games'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='game_hides' AND policyname='admins with manage_games can delete') THEN
    CREATE POLICY "admins with manage_games can delete" ON public.game_hides
      FOR DELETE TO authenticated
      USING (public.current_user_has_permission('manage_games'));
  END IF;
END $$;

-- ── game_remaps ──
CREATE TABLE IF NOT EXISTS public.game_remaps (
  from_app_id  TEXT PRIMARY KEY,
  to_app_id    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  remapped_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_remaps_no_self_loop CHECK (from_app_id <> to_app_id)
);

ALTER TABLE public.game_remaps ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='game_remaps' AND policyname='anyone can read game_remaps') THEN
    CREATE POLICY "anyone can read game_remaps" ON public.game_remaps
      FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='game_remaps' AND policyname='admins with manage_games can insert') THEN
    CREATE POLICY "admins with manage_games can insert" ON public.game_remaps
      FOR INSERT TO authenticated
      WITH CHECK (public.current_user_has_permission('manage_games'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='game_remaps' AND policyname='admins with manage_games can update') THEN
    CREATE POLICY "admins with manage_games can update" ON public.game_remaps
      FOR UPDATE TO authenticated
      USING (public.current_user_has_permission('manage_games'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='game_remaps' AND policyname='admins with manage_games can delete') THEN
    CREATE POLICY "admins with manage_games can delete" ON public.game_remaps
      FOR DELETE TO authenticated
      USING (public.current_user_has_permission('manage_games'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.update_game_remaps_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS game_remaps_updated_at ON public.game_remaps;
CREATE TRIGGER game_remaps_updated_at
  BEFORE UPDATE ON public.game_remaps
  FOR EACH ROW EXECUTE FUNCTION public.update_game_remaps_updated_at();

-- ── Backfill existing moderators with manage_games ──
UPDATE public.admins
  SET permissions = array_append(permissions, 'manage_games')
  WHERE role = 'moderator'
    AND NOT ('manage_games' = ANY(permissions));

-- Super admins short-circuit to all permissions via current_user_has_permission,
-- so no explicit grant needed there.
