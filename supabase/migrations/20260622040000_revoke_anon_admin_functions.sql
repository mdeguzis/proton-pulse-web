-- Revoke anon/public execute from admin-only and trigger-only functions.
-- These functions are not intended to be callable via the REST API by anonymous users.
-- Admin functions have internal guards but should fail at the grant level first.
-- Trigger functions are called only by the DB engine, never via RPC.

revoke execute on function public.admin_analytics(integer) from public, anon;
revoke execute on function public.admin_list_users() from public, anon;
revoke execute on function public.hide_configs_on_ban() from public, anon;
revoke execute on function public.prevent_last_super_admin_removal() from public, anon;
revoke execute on function public.snapshot_user_configs_before_update() from public, anon;
revoke execute on function public.set_user_configs_updated_at() from public, anon;
revoke execute on function public.set_flagged_reports_updated_at() from public, anon;
