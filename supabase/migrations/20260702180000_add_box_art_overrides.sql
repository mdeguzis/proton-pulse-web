-- Box art overrides: admin-curated header images that survive pipeline reruns.
-- Set/cleared via the Box Art Manager admin tab; served through game-images.json
-- (Steam) and nonsteam-images.json (GOG/Epic) which the pipeline seeds from
-- this table before probing. Uploaded images live in the "boxart" storage
-- bucket; manual URL entries can point anywhere the pipeline can reach.

CREATE TABLE IF NOT EXISTS public.box_art_overrides (
  app_id      TEXT PRIMARY KEY,
  image_url   TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('manual', 'upload', 'sgdb')),
  set_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.box_art_overrides ENABLE ROW LEVEL SECURITY;

-- Public read: pipeline pulls this via the anon-key REST endpoint, and
-- browsers may hit it directly if we later cache-bust game-images.json.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='box_art_overrides' AND policyname='anyone can read box art overrides') THEN
    CREATE POLICY "anyone can read box art overrides" ON public.box_art_overrides
      FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;

-- Write access gated by the manage_box_art permission. super_admin
-- short-circuits to allow all permissions per current_user_has_permission.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='box_art_overrides' AND policyname='admins with manage_box_art can insert') THEN
    CREATE POLICY "admins with manage_box_art can insert" ON public.box_art_overrides
      FOR INSERT TO authenticated
      WITH CHECK (public.current_user_has_permission('manage_box_art'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='box_art_overrides' AND policyname='admins with manage_box_art can update') THEN
    CREATE POLICY "admins with manage_box_art can update" ON public.box_art_overrides
      FOR UPDATE TO authenticated
      USING (public.current_user_has_permission('manage_box_art'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='box_art_overrides' AND policyname='admins with manage_box_art can delete') THEN
    CREATE POLICY "admins with manage_box_art can delete" ON public.box_art_overrides
      FOR DELETE TO authenticated
      USING (public.current_user_has_permission('manage_box_art'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.update_box_art_overrides_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS box_art_overrides_updated_at ON public.box_art_overrides;
CREATE TRIGGER box_art_overrides_updated_at
  BEFORE UPDATE ON public.box_art_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_box_art_overrides_updated_at();

-- Backfill existing moderators with manage_box_art. New moderators added
-- after this migration get the perm from the seed logic in
-- 20260616010000_admin_granular_permissions.sql once that's updated too.
UPDATE public.admins
  SET permissions = array_append(permissions, 'manage_box_art')
  WHERE role = 'moderator'
    AND NOT ('manage_box_art' = ANY(permissions));

-- Storage bucket for uploaded box art. Public read so the images can be
-- served straight from the CDN URL; only admins with manage_box_art can
-- write. Size cap keeps abuse in check; MIME allowlist blocks scripts.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('boxart', 'boxart', true, 2097152, ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='public read on boxart bucket') THEN
    CREATE POLICY "public read on boxart bucket" ON storage.objects
      FOR SELECT USING (bucket_id = 'boxart');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='admins can insert boxart') THEN
    CREATE POLICY "admins can insert boxart" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'boxart' AND public.current_user_has_permission('manage_box_art'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='admins can update boxart') THEN
    CREATE POLICY "admins can update boxart" ON storage.objects
      FOR UPDATE TO authenticated
      USING (bucket_id = 'boxart' AND public.current_user_has_permission('manage_box_art'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='admins can delete boxart') THEN
    CREATE POLICY "admins can delete boxart" ON storage.objects
      FOR DELETE TO authenticated
      USING (bucket_id = 'boxart' AND public.current_user_has_permission('manage_box_art'));
  END IF;
END $$;
