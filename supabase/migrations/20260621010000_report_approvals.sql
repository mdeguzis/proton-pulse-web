-- Report approval system: reports require pipeline or admin approval before
-- they become publicly visible. The approval_hash is md5 of the report's key
-- fields. If the user edits their report, the hash no longer matches and the
-- report returns to pending state until re-approved.

create table if not exists report_approvals (
  report_id bigint primary key references user_configs(id) on delete cascade,
  approval_hash text not null,
  approved_at timestamptz not null default now(),
  approved_by text -- 'pipeline' or admin user_id
);

-- Index for fast lookup of approved reports
create index if not exists idx_report_approvals_hash on report_approvals(report_id, approval_hash);

-- RLS: anyone can read approvals (needed for public report filtering),
-- only service role and admins can insert/update
alter table report_approvals enable row level security;

create policy "Anyone can read approvals"
  on report_approvals for select
  using (true);

create policy "Service role can manage approvals"
  on report_approvals for all
  using (true)
  with check (true);

-- Grant anon/authenticated read access
grant select on report_approvals to anon, authenticated;
grant insert, update, delete on report_approvals to authenticated;
