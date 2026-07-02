-- Proton is a Linux-only compatibility layer (SteamOS + desktop Linux
-- distros only). macOS lost Steam Play support years ago; Windows runs
-- games natively; BSD variants aren't Proton targets. Reports for any
-- of those OSes are noise for this site.
--
-- Blocklist rather than allowlist so any current or future Linux distro
-- (Alpine, Void, Slackware, Solus, custom / rolling releases) passes
-- through without needing schema edits. Verified pre-flight: no
-- existing rows violate this constraint at time of authoring.

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
      lower(os) !~ '^ios($|\s)' AND
      lower(os) !~ '^android'
    )
  );

COMMENT ON CONSTRAINT user_configs_os_must_be_linux ON user_configs IS
  'Proton only runs on Linux (incl. SteamOS). Reports for Windows / macOS / BSD / iOS / Android are rejected. Any Linux distro passes.';
