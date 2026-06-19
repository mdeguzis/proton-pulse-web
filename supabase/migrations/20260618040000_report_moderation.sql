-- Universal report suppression for reports we do not own a DB row for (ProtonDB
-- mirror reports). Pulse reports live in user_configs and use is_hidden, but
-- ProtonDB reports come from the static mirror, so to act on them on our site we
-- record a suppression here and filter at display time. Our site, our rules.

CREATE TABLE IF NOT EXISTS public.report_moderation (
  id           bigserial PRIMARY KEY,
  flag_id      bigint      REFERENCES public.flagged_reports(id) ON DELETE SET NULL,
  app_id       text        NOT NULL,
  report_key   text        NOT NULL,
  source       text        NOT NULL,
  action       text        NOT NULL DEFAULT 'shadowban', -- 'shadowban' | 'deleted'
  reason       text,
  moderated_by uuid,
  flagged_at   timestamptz,                       -- original flag time, for ordering
  moderated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, report_key, source)
);

CREATE INDEX IF NOT EXISTS idx_report_moderation_app ON public.report_moderation (app_id);
CREATE INDEX IF NOT EXISTS idx_report_moderation_flag ON public.report_moderation (flag_id);

ALTER TABLE public.report_moderation ENABLE ROW LEVEL SECURITY;

-- Public can read suppressions so the site can filter hidden reports out at
-- render time. The rows contain no sensitive data (app id + opaque key).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='report_moderation' AND policyname='public read report_moderation') THEN
    CREATE POLICY "public read report_moderation"
      ON public.report_moderation FOR SELECT
      USING (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='report_moderation' AND policyname='admins write report_moderation') THEN
    CREATE POLICY "admins write report_moderation"
      ON public.report_moderation FOR ALL
      TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid()));
  END IF;
END $$;
