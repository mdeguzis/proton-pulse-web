-- #406: PCGW games move from `pgwiki:<slug>` app ids to short deterministic
-- hashes `pw_<8-char-base36>` (base36 of the first 48 bits of sha256(slug)).
-- Remap every stored pgwiki: app_id in place. The hash function here MUST
-- stay byte-identical to:
--   scripts/pipeline/pcgamingwiki_catalog.py  slug_to_pw_id()
--   js/lib/app-id.js                          pcgwSlugToPwId()
-- (verified three ways before this migration was applied).
--
-- Views (config_playtime_totals, config_playtime_user, report_vote_totals)
-- derive from the base tables and need no update. steam_depot_* and
-- user_proton_configs are bigint app_id (Steam-only) and cannot hold
-- pgwiki rows.

CREATE OR REPLACE FUNCTION public.pcgw_slug_to_pw_id(slug text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $fn$
DECLARE
  h bytea := extensions.digest(slug, 'sha256');
  n bigint := 0;
  chars text := '0123456789abcdefghijklmnopqrstuvwxyz';
  out_str text := '';
  i int;
BEGIN
  FOR i IN 0..5 LOOP
    n := n * 256 + get_byte(h, i);
  END LOOP;
  FOR i IN 1..8 LOOP
    out_str := out_str || substr(chars, (n % 36)::int + 1, 1);
    n := n / 36;
  END LOOP;
  RETURN 'pw_' || out_str;
END
$fn$;

-- Remap every base table that stores canonical app ids as text.
UPDATE public.user_configs
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.user_configs_history
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.report_moderation
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.box_art_overrides
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.boxart_confirmed_ok
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.image_load_errors
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.report_votes
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.game_hides
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.user_report_drafts
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.flagged_reports
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

UPDATE public.config_playtime
  SET app_id = public.pcgw_slug_to_pw_id(substr(app_id, 8))
  WHERE app_id LIKE 'pgwiki:%';

-- Keep the function: new pgwiki-slugged writes from stale clients can be
-- re-run through the same UPDATEs, and support tooling can call it to
-- translate a slug by hand.
