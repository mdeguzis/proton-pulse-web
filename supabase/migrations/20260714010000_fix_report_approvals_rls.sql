-- Fix: restrict report_approvals writes to service_role only.
-- Previously INSERT/UPDATE/DELETE were granted to all authenticated users,
-- meaning anyone could self-approve their own report.

revoke insert, update, delete on report_approvals from authenticated;

-- Drop the overly permissive policy
drop policy if exists "Service role can manage approvals" on report_approvals;

-- Service role bypasses RLS entirely so no explicit policy needed for it.
-- Add an admin-only write policy for manual approvals via the admin panel.
create policy "Admins can manage approvals"
  on report_approvals for all
  using (
    auth.uid() in (select user_id from admins where permissions @> '["moderate_reports"]')
  )
  with check (
    auth.uid() in (select user_id from admins where permissions @> '["moderate_reports"]')
  );
