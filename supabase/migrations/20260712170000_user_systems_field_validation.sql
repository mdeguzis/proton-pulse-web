-- Field validation for user_systems (security hardening).
--
-- sysinfo_text is hardware info, not PII, so it is kept and publicly readable.
-- What it does need is strict input validation so the field cannot be abused as
-- a dumping ground: oversized payloads, control-character / binary injection, or
-- junk device handles. These CHECK constraints are the authoritative gate. They
-- catch every writer, both the plugin (user-system-upload edge function) and the
-- web app (direct PostgREST POST / PATCH), which a per-endpoint check cannot.
--
-- Verified against live data before adding: max sysinfo_text 1920 chars, all
-- printable; max device_id 36 chars, all within the handle charset; max label
-- 26 chars. Nothing existing violates these.

alter table public.user_systems
  add constraint user_systems_sysinfo_len
    check (char_length(sysinfo_text) between 1 and 16384),
  add constraint user_systems_sysinfo_printable
    check (sysinfo_text ~ '^[[:print:][:space:]]*$'),
  add constraint user_systems_device_id_valid
    check (char_length(device_id) between 1 and 128
           and device_id ~ '^[A-Za-z0-9._:-]+$'),
  add constraint user_systems_label_len
    check (char_length(coalesce(label, '')) <= 160);
