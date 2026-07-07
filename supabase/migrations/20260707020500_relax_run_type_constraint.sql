-- Broaden run_type from the strict ('native','proton') enum so the pipeline
-- can populate additional runtimes it discovers from ProtonDB notes and
-- launch options (e.g. 'proton-lsfg' for Lossless Scaling FrameGen wrappers,
-- 'proton-ge', etc.). Data hygiene stays enforced via a regex + length check
-- rather than an enum, so extending the taxonomy no longer requires a
-- migration. Canonical values are defined in js/shared/run-type.js.

alter table public.user_configs
  drop constraint if exists user_configs_run_type_chk;

alter table public.user_configs
  add constraint user_configs_run_type_chk check (
    run_type is null
    or (
      char_length(run_type) between 1 and 32
      and run_type ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    )
  );
