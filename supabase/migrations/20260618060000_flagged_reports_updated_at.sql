-- Track when a flag was last touched (i.e. last reviewed). flagged_reports only
-- had flagged_at; admins need to see when a review action last happened.

ALTER TABLE public.flagged_reports
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Backfill existing rows so the column is not null going forward.
UPDATE public.flagged_reports SET updated_at = flagged_at WHERE updated_at IS NULL;

CREATE OR REPLACE FUNCTION public.set_flagged_reports_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flagged_reports_updated_at_trigger ON public.flagged_reports;
CREATE TRIGGER flagged_reports_updated_at_trigger
  BEFORE UPDATE ON public.flagged_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_flagged_reports_updated_at();
