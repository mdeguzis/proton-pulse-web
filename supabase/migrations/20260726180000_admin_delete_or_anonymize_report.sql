-- #398: per-report admin resolution -- permanently delete OR anonymize.
--
-- Anonymize keeps the compatibility data intact (it is still a valid
-- datapoint) but scrubs every identity linkage, the same treatment
-- admin_erase_user gives a deleted account's rows: proton_pulse_user_id
-- and installation_id null out, client_id becomes a fresh unguessable
-- anon_ token, anonymized_at is stamped. Delete removes the row entirely
-- (history rows cascade via the config_id FK).
--
-- SECURITY DEFINER with a locked search_path; callable only by admins
-- with the matching granular permission (delete_reports for delete,
-- manage_reports for anonymize). Every call lands in admin_audit_log.

create or replace function public.admin_resolve_report(
  p_report_id bigint,
  p_action    text  -- 'delete' | 'anonymize'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row        public.user_configs%rowtype;
  v_anon       text;
  v_permission text;
begin
  if p_action not in ('delete', 'anonymize') then
    raise exception 'admin_resolve_report: action must be delete or anonymize';
  end if;

  v_permission := case p_action when 'delete' then 'delete_reports' else 'manage_reports' end;
  if not public.current_user_has_permission(v_permission) then
    raise exception 'admin_resolve_report: caller lacks % permission', v_permission;
  end if;

  select * into v_row from public.user_configs where id = p_report_id;
  if not found then
    raise exception 'admin_resolve_report: report % not found', p_report_id;
  end if;

  if p_action = 'delete' then
    -- History rows reference config_id; remove them first (no FK cascade on
    -- this table historically -- match deleteMyReportsEverywhere's order).
    delete from public.user_configs_history where config_id = p_report_id;
    delete from public.report_approvals where report_id = p_report_id;
    delete from public.user_configs where id = p_report_id;
  else
    v_anon := 'anon_' || replace(gen_random_uuid()::text, '-', '');
    update public.user_configs
    set proton_pulse_user_id = null,
        installation_id      = null,
        client_id            = v_anon,
        anonymized_at        = now()
    where id = p_report_id;
  end if;

  insert into public.admin_audit_log (actor_user_id, action, target_hash, anon_token, details)
  values (
    auth.uid(),
    'report_' || p_action,
    md5(p_report_id::text),
    v_anon,
    json_build_object('report_id', p_report_id, 'app_id', v_row.app_id, 'title', v_row.title, 'source', v_row.source)::jsonb
  );

  return json_build_object('ok', true, 'action', p_action, 'report_id', p_report_id);
end;
$$;

grant execute on function public.admin_resolve_report(bigint, text) to authenticated;
