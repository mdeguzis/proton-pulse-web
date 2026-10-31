-- Lock report_approvals writes to moderators (security fix, 2026-10-30).
--
-- "Service role can manage approvals" was FOR ALL TO public USING (true)
-- WITH CHECK (true). The service role bypasses RLS, so the policy did
-- nothing for the pipeline and instead let anyone holding the public anon
-- key insert, rewrite or delete approvals. computeHash() is public JS, so a
-- caller could approve their own report and skip moderation. Verified as
-- anon in a rolled-back transaction: UPDATE and DELETE hit all 22 rows.
--
-- Legitimate writers after this change:
--   * pipeline approve_reports.py  - service key, bypasses RLS (unchanged)
--   * admin Pending tab approve    - manage_reports permission
--   * owner edit (submit.js, profile configs.js) - DELETE of the approval
--     for a report the signed-in user owns, so the edit gets re-reviewed
-- "Anyone can read approvals" (SELECT) is unchanged.

DROP POLICY IF EXISTS "Service role can manage approvals" ON public.report_approvals;

CREATE POLICY "manage_reports insert approvals" ON public.report_approvals
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_has_permission('manage_reports'));

CREATE POLICY "manage_reports update approvals" ON public.report_approvals
  FOR UPDATE TO authenticated
  USING (public.current_user_has_permission('manage_reports'))
  WITH CHECK (public.current_user_has_permission('manage_reports'));

CREATE POLICY "moderator or owner delete approvals" ON public.report_approvals
  FOR DELETE TO authenticated
  USING (
    public.current_user_has_permission('manage_reports')
    OR EXISTS (
      SELECT 1 FROM public.user_configs uc
      WHERE uc.id = report_approvals.report_id
        AND uc.proton_pulse_user_id = (SELECT auth.uid())
    )
  );

-- Anon never writes approvals; drop the table-level write grants too so a
-- future permissive policy cannot reopen this by accident.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.report_approvals FROM anon;
REVOKE TRUNCATE ON public.report_approvals FROM authenticated;
