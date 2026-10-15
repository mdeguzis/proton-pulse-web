-- #544: lift the Android blocklist entry from user_configs_os_must_be_linux.
--
-- The original constraint (20260701210000) rejected Android on the premise
-- that "Proton is a Linux-only compatibility layer." DroidDeck breaks that
-- premise: it's a regular Android app (no root, no OS replacement) that runs
-- Valve's own ARM64 Proton directly on stock Android. A real Proton report
-- from Android is now a legitimate thing to want, not noise.
--
-- iOS stays blocked -- no equivalent exists there. Windows / macOS / BSD
-- are unaffected.

ALTER TABLE user_configs
  DROP CONSTRAINT user_configs_os_must_be_linux;

ALTER TABLE user_configs
  ADD CONSTRAINT user_configs_os_must_be_linux
  CHECK (
    os IS NULL OR os = '' OR (
      lower(os) !~ '^windows'   AND
      lower(os) !~ '^win\s'     AND
      lower(os) !~ '^win\d'     AND
      lower(os) !~ '^mac\s?os'  AND
      lower(os) !~ '^os\s?x'    AND
      lower(os) !~ '^darwin'    AND
      lower(os) !~ '^freebsd'   AND
      lower(os) !~ '^openbsd'   AND
      lower(os) !~ '^netbsd'    AND
      lower(os) !~ '^dragonfly' AND
      lower(os) !~ '^ios($|\s)'
    )
  );

COMMENT ON CONSTRAINT user_configs_os_must_be_linux ON user_configs IS
  'Proton (desktop/SteamOS) or a real ARM64 Proton build (Android via DroidDeck) is required. Windows / macOS / BSD / iOS are rejected. Any Linux distro or Android passes.';
