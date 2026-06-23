-- Pin search_path on all public functions that had it mutable.
-- A mutable search_path on a security definer function can allow search path hijacking
-- if a malicious schema is placed earlier in the path.

alter function public.update_my_cloud_config(bigint, text, jsonb) set search_path = public;
alter function public.set_user_configs_updated_at() set search_path = public;
alter function public.set_flagged_reports_updated_at() set search_path = public;
alter function public.author_stats_by_client(text) set search_path = public;
alter function public.author_stats_by_user(uuid) set search_path = public;
alter function public.get_author_avatars(uuid[]) set search_path = public;
alter function public.hide_configs_on_ban() set search_path = public;
alter function public.admin_analytics(integer) set search_path = public;
