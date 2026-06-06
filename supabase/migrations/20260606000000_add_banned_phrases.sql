CREATE TABLE IF NOT EXISTS public.banned_phrases (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern     text        NOT NULL,
  is_regex    boolean     NOT NULL DEFAULT false,
  description text,
  enabled     boolean     NOT NULL DEFAULT true,
  created_by  uuid        REFERENCES public.admins(proton_pulse_user_id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.banned_phrases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_read_banned_phrases" ON public.banned_phrases
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid())
  );

CREATE POLICY "super_admins_insert_banned_phrases" ON public.banned_phrases
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "super_admins_update_banned_phrases" ON public.banned_phrases
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "super_admins_delete_banned_phrases" ON public.banned_phrases
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid() AND role = 'super_admin')
  );
