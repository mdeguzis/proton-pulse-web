-- Re-flagging a report must re-open its flag, not silently 409.
--
-- flagged_reports has UNIQUE (app_id, report_key), so a second flag on the same
-- report hits the unique constraint. The client treated 409 as success, but the
-- existing flag was left as-is, so a report that had been reviewed/resolved
-- could never be resurfaced. Anon cannot UPDATE flagged_reports (only admins
-- can), so we expose a SECURITY DEFINER upsert that re-opens the flag.

CREATE OR REPLACE FUNCTION public.submit_flag(
  p_app_id             text,
  p_report_key         text,
  p_source             text,
  p_reason_category    text,
  p_reason_text        text,
  p_reporter_client_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.flagged_reports
    (app_id, report_key, source, reason_category, reason_text, reporter_client_id, status, flagged_at)
  VALUES
    (p_app_id, p_report_key, COALESCE(p_source, 'unknown'), p_reason_category, p_reason_text, p_reporter_client_id, 'open', now())
  ON CONFLICT (app_id, report_key) DO UPDATE SET
    status             = 'open',
    flagged_at         = now(),
    source             = COALESCE(EXCLUDED.source, public.flagged_reports.source),
    reason_category    = COALESCE(EXCLUDED.reason_category, public.flagged_reports.reason_category),
    reason_text        = COALESCE(EXCLUDED.reason_text, public.flagged_reports.reason_text),
    reporter_client_id = COALESCE(EXCLUDED.reporter_client_id, public.flagged_reports.reporter_client_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_flag(text, text, text, text, text, text) TO anon, authenticated;
