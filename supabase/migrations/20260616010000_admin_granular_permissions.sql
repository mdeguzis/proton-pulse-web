-- Granular admin permissions: role presets (moderator/super_admin) that fill a
-- permission group, plus per-admin granular overrides. super_admin is always
-- implicitly all-permissions (not reducible). Enforcement is via RLS using a
-- single helper; the frontend mirrors the same set to show only what a role can
-- do. Public/owner policies on these tables are left untouched.
--
-- Canonical permission keys:
--   manage_reports  - flag/hide/reinstate reports
--   delete_reports  - permanently delete reports
--   ban_users       - ban/unban users
--   manage_phrases  - banned phrases CRUD
--   manage_admins   - admins CRUD + assign roles/permissions
--   view_analytics  - Analytics tab

-- 1. permissions column + allow the 'custom' role label
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.admins DROP CONSTRAINT IF EXISTS admins_role_check;
ALTER TABLE public.admins ADD CONSTRAINT admins_role_check
  CHECK (role = ANY (ARRAY['super_admin','moderator','custom']));

-- 2. backfill effective permissions from existing roles
UPDATE public.admins
SET permissions = ARRAY['manage_reports','delete_reports','ban_users','view_analytics']
WHERE role = 'moderator';

UPDATE public.admins
SET permissions = ARRAY['manage_reports','delete_reports','ban_users','manage_phrases','manage_admins','view_analytics']
WHERE role = 'super_admin';

-- 3. effective-permission helper. super_admin short-circuits to all permissions.
CREATE OR REPLACE FUNCTION public.current_user_has_permission(p text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admins
    WHERE proton_pulse_user_id = auth.uid()
      AND (role = 'super_admin' OR p = ANY(permissions))
  );
$$;
GRANT EXECUTE ON FUNCTION public.current_user_has_permission(text) TO authenticated, anon;

-- 4. RLS rewrites. Only admin-scoped policies change; public read, anon insert,
--    and owner update/delete policies are left in place.

-- banned_users: any admin reads the list; ban_users may insert/delete.
DROP POLICY IF EXISTS "admins manage banned users" ON public.banned_users;
CREATE POLICY "admins read banned users" ON public.banned_users
  FOR SELECT USING (public.is_current_user_admin());
CREATE POLICY "ban_users insert banned users" ON public.banned_users
  FOR INSERT WITH CHECK (public.current_user_has_permission('ban_users'));
CREATE POLICY "ban_users delete banned users" ON public.banned_users
  FOR DELETE USING (public.current_user_has_permission('ban_users'));

-- user_configs: manage_reports for update (hide/flag/reinstate), delete_reports for delete.
DROP POLICY IF EXISTS "admins update any config" ON public.user_configs;
CREATE POLICY "manage_reports update configs" ON public.user_configs
  FOR UPDATE USING (public.current_user_has_permission('manage_reports'))
  WITH CHECK (public.current_user_has_permission('manage_reports'));
DROP POLICY IF EXISTS "admins delete any config" ON public.user_configs;
CREATE POLICY "delete_reports delete configs" ON public.user_configs
  FOR DELETE USING (public.current_user_has_permission('delete_reports'));

-- banned_phrases: manage_phrases for all writes.
DROP POLICY IF EXISTS "super_admins_insert_banned_phrases" ON public.banned_phrases;
DROP POLICY IF EXISTS "super_admins_update_banned_phrases" ON public.banned_phrases;
DROP POLICY IF EXISTS "super_admins_delete_banned_phrases" ON public.banned_phrases;
CREATE POLICY "manage_phrases insert banned phrases" ON public.banned_phrases
  FOR INSERT WITH CHECK (public.current_user_has_permission('manage_phrases'));
CREATE POLICY "manage_phrases update banned phrases" ON public.banned_phrases
  FOR UPDATE USING (public.current_user_has_permission('manage_phrases'))
  WITH CHECK (public.current_user_has_permission('manage_phrases'));
CREATE POLICY "manage_phrases delete banned phrases" ON public.banned_phrases
  FOR DELETE USING (public.current_user_has_permission('manage_phrases'));

-- admins: manage_admins for writes. Keep the no-self-delete guard.
DROP POLICY IF EXISTS "super admins insert admins" ON public.admins;
DROP POLICY IF EXISTS "super admins update admins" ON public.admins;
DROP POLICY IF EXISTS "super admins delete admins" ON public.admins;
CREATE POLICY "manage_admins insert admins" ON public.admins
  FOR INSERT WITH CHECK (public.current_user_has_permission('manage_admins'));
CREATE POLICY "manage_admins update admins" ON public.admins
  FOR UPDATE USING (public.current_user_has_permission('manage_admins'))
  WITH CHECK (public.current_user_has_permission('manage_admins'));
CREATE POLICY "manage_admins delete admins" ON public.admins
  FOR DELETE USING (public.current_user_has_permission('manage_admins') AND proton_pulse_user_id <> auth.uid());

-- 5. Guard: never remove or demote the last super_admin.
CREATE OR REPLACE FUNCTION public.prevent_last_super_admin_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  remaining int;
BEGIN
  IF tg_op = 'DELETE' AND old.role = 'super_admin' THEN
    SELECT count(*) INTO remaining FROM public.admins
      WHERE role = 'super_admin' AND proton_pulse_user_id <> old.proton_pulse_user_id;
    IF remaining = 0 THEN RAISE EXCEPTION 'cannot remove the last super_admin'; END IF;
    RETURN old;
  ELSIF tg_op = 'UPDATE' AND old.role = 'super_admin' AND new.role <> 'super_admin' THEN
    SELECT count(*) INTO remaining FROM public.admins
      WHERE role = 'super_admin' AND proton_pulse_user_id <> old.proton_pulse_user_id;
    IF remaining = 0 THEN RAISE EXCEPTION 'cannot demote the last super_admin'; END IF;
    RETURN new;
  END IF;
  RETURN COALESCE(new, old);
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_last_super_admin ON public.admins;
CREATE TRIGGER trg_prevent_last_super_admin
  BEFORE UPDATE OR DELETE ON public.admins
  FOR EACH ROW EXECUTE FUNCTION public.prevent_last_super_admin_removal();
