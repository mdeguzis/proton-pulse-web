-- RPC for admin panel: returns all auth.users with last_sign_in_at.
-- Restricted to users with a row in the admins table.
CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE(
  id            uuid,
  display_name  text,
  last_sign_in_at timestamptz,
  created_at    timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden: admin access required';
  END IF;
  RETURN QUERY
    SELECT
      u.id,
      (u.raw_user_meta_data->>'name')::text AS display_name,
      u.last_sign_in_at,
      u.created_at
    FROM auth.users u
    ORDER BY u.last_sign_in_at DESC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_users() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated;
