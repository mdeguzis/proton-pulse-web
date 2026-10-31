-- Client secrets + write RPCs for anonymous clients (#62).
--
-- Anonymous writers (the Decky plugin, and the web site's voting) get a
-- per-client secret and a set of SECURITY DEFINER RPCs for their writes:
-- votes, cloud-synced configs, plugin settings backup, playtime sessions
-- and their own reports. Every RPC checks the secret and the ban list.
-- This migration only adds; it changes no existing policy.
--
-- How ownership works now:
--   * Each client keeps a random secret next to its client id. The plugin
--     reuses its installation secret (the one plugin-link-* already
--     hashes into plugin_links); the web site generates its own.
--   * public.client_secrets stores sha256(secret) per client id. Nobody
--     but the service role can read it.
--   * The first call for a client id registers its hash. Every later call
--     must present the same secret. If the client id already appears next
--     to a linked installation (plugin_links has that installation's
--     secret hash), the first claim must match that hash, so only that
--     install can register it.
--   * Every write RPC also refuses banned clients (banned_users by
--     client_id, or by the linked Proton Pulse user). banned_until adds
--     timed bans (#62); NULL means permanent.
--   * proton_pulse_user_id is never taken from the caller. It is derived
--     from plugin_links (installation id + matching secret hash).

-- ---------------------------------------------------------------------------
-- Timed bans (#62)
-- ---------------------------------------------------------------------------
ALTER TABLE public.banned_users
  ADD COLUMN IF NOT EXISTS banned_until timestamptz;

COMMENT ON COLUMN public.banned_users.banned_until IS
  'NULL = permanent ban. A past timestamp means the ban has expired.';

-- ---------------------------------------------------------------------------
-- Secret store
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_secrets (
  client_id    text PRIMARY KEY,
  secret_hash  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.client_secrets ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only SECURITY DEFINER functions and the service
-- role touch this table.
REVOKE ALL ON public.client_secrets FROM anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by API roles)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.client_linked_user(p_installation_id text, p_secret text)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT pl.linked_user_id
  FROM public.plugin_links pl
  WHERE p_installation_id IS NOT NULL
    AND pl.installation_id = p_installation_id
    AND pl.installation_secret_hash = encode(extensions.digest(p_secret, 'sha256'), 'hex')
    AND pl.linked_user_id IS NOT NULL
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.client_is_banned(p_client_id text, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.banned_users b
    WHERE (b.banned_until IS NULL OR b.banned_until > now())
      AND ((p_client_id IS NOT NULL AND b.client_id = p_client_id)
        OR (p_user_id IS NOT NULL AND b.proton_pulse_user_id = p_user_id))
  );
$$;

-- Raises unless p_secret is the registered secret for p_client_id (or the
-- first claim of an unregistered id), and the client is not banned.
CREATE OR REPLACE FUNCTION public.client_verify(p_client_id text, p_secret text, p_user_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_hash   text;
  v_stored text;
  v_linked text;
BEGIN
  IF p_client_id IS NULL OR p_client_id !~ '^[A-Za-z0-9-]{8,64}$' THEN
    RAISE EXCEPTION 'invalid client id' USING ERRCODE = '22023';
  END IF;
  IF p_secret IS NULL OR length(p_secret) < 32 OR length(p_secret) > 200 THEN
    RAISE EXCEPTION 'invalid client secret' USING ERRCODE = '22023';
  END IF;

  v_hash := encode(extensions.digest(p_secret, 'sha256'), 'hex');

  SELECT secret_hash INTO v_stored FROM public.client_secrets WHERE client_id = p_client_id;
  IF v_stored IS NULL THEN
    -- First claim. If this client id was used by a linked installation,
    -- that installation's secret is already known; require it.
    SELECT pl.installation_secret_hash INTO v_linked
    FROM public.plugin_links pl
    WHERE pl.installation_secret_hash IS NOT NULL
      AND pl.installation_id IN (
        SELECT upc.installation_id FROM public.user_proton_configs upc
        WHERE upc.voter_id = p_client_id AND upc.installation_id IS NOT NULL
        UNION
        SELECT uc.installation_id FROM public.user_configs uc
        WHERE uc.client_id = p_client_id AND uc.installation_id IS NOT NULL
      )
    LIMIT 1;
    IF v_linked IS NOT NULL AND v_linked <> v_hash THEN
      RAISE EXCEPTION 'client secret mismatch' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.client_secrets (client_id, secret_hash)
    VALUES (p_client_id, v_hash)
    ON CONFLICT (client_id) DO NOTHING;
    -- Lost a race to a concurrent first claim: re-check against the winner.
    SELECT secret_hash INTO v_stored FROM public.client_secrets WHERE client_id = p_client_id;
  END IF;

  IF v_stored <> v_hash THEN
    RAISE EXCEPTION 'client secret mismatch' USING ERRCODE = '42501';
  END IF;

  IF public.client_is_banned(p_client_id, p_user_id) THEN
    RAISE EXCEPTION 'client is banned' USING ERRCODE = '42501';
  END IF;

  UPDATE public.client_secrets SET last_used_at = now()
  WHERE client_id = p_client_id AND last_used_at < now() - interval '1 hour';
END;
$$;

REVOKE ALL ON FUNCTION public.client_linked_user(text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.client_is_banned(text, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.client_verify(text, text, uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Votes
-- ---------------------------------------------------------------------------
-- p_vote 1 / -1 sets the vote, 0 clears it.
CREATE OR REPLACE FUNCTION public.client_cast_vote(
  p_client_id text, p_secret text, p_app_id text, p_report_key text, p_vote smallint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret);
  IF p_vote NOT IN (-1, 0, 1) THEN
    RAISE EXCEPTION 'vote must be -1, 0 or 1' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_app_id, '') = '' OR coalesce(p_report_key, '') = '' THEN
    RAISE EXCEPTION 'app id and report key are required' USING ERRCODE = '22023';
  END IF;

  IF p_vote = 0 THEN
    DELETE FROM public.report_votes
    WHERE voter_id = p_client_id AND app_id = p_app_id AND report_key = p_report_key;
  ELSE
    INSERT INTO public.report_votes (voter_id, app_id, report_key, vote)
    VALUES (p_client_id, p_app_id, p_report_key, p_vote)
    ON CONFLICT (voter_id, app_id, report_key) DO UPDATE SET vote = EXCLUDED.vote;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cloud-synced configs (user_proton_configs)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.client_save_cloud_config(
  p_client_id text, p_secret text, p_installation_id text,
  p_app_id bigint, p_app_name text, p_profile_name text, p_config jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_user    uuid := public.client_linked_user(p_installation_id, p_secret);
  v_profile text := coalesce(nullif(btrim(p_profile_name), ''), 'Default');
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret, v_user);
  IF p_app_id IS NULL OR p_config IS NULL THEN
    RAISE EXCEPTION 'app id and config are required' USING ERRCODE = '22023';
  END IF;

  -- is_published is left alone on update: publishing is a separate,
  -- explicit action on the web profile.
  INSERT INTO public.user_proton_configs
    (voter_id, proton_pulse_user_id, installation_id, is_published,
     app_id, app_name, profile_name, config, updated_at)
  VALUES
    (p_client_id, v_user, p_installation_id, false,
     p_app_id, p_app_name, v_profile, p_config, now())
  ON CONFLICT (voter_id, app_id, profile_name) DO UPDATE SET
    proton_pulse_user_id = EXCLUDED.proton_pulse_user_id,
    installation_id      = EXCLUDED.installation_id,
    app_name             = EXCLUDED.app_name,
    config               = EXCLUDED.config,
    updated_at           = now();
END;
$$;

-- p_profile_name NULL removes every profile for the app.
CREATE OR REPLACE FUNCTION public.client_delete_cloud_config(
  p_client_id text, p_secret text, p_app_id bigint, p_profile_name text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret);
  DELETE FROM public.user_proton_configs
  WHERE voter_id = p_client_id
    AND app_id = p_app_id
    AND (nullif(btrim(p_profile_name), '') IS NULL OR profile_name = btrim(p_profile_name));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Not STABLE: client_verify registers the first claim.
-- This client's rows, plus rows from other installs of the same linked
-- account (linked user derived from plugin_links, never from the caller).
CREATE OR REPLACE FUNCTION public.client_my_cloud_configs(
  p_client_id text, p_secret text, p_installation_id text DEFAULT NULL)
RETURNS SETOF public.user_proton_configs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_user uuid := public.client_linked_user(p_installation_id, p_secret);
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret, v_user);
  RETURN QUERY
    SELECT * FROM public.user_proton_configs upc
    WHERE upc.voter_id = p_client_id
       OR (v_user IS NOT NULL AND upc.proton_pulse_user_id = v_user);
END;
$$;

-- ---------------------------------------------------------------------------
-- Plugin settings backup (user_plugin_settings)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.client_save_plugin_settings(
  p_client_id text, p_secret text, p_plugin_id text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret);
  IF coalesce(p_plugin_id, '') = '' OR p_payload IS NULL THEN
    RAISE EXCEPTION 'plugin id and payload are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.user_plugin_settings (voter_id, plugin_id, payload, updated_at)
  VALUES (p_client_id, p_plugin_id, p_payload, now())
  ON CONFLICT (voter_id, plugin_id) DO UPDATE SET
    payload = EXCLUDED.payload, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.client_my_plugin_settings(
  p_client_id text, p_secret text, p_plugin_id text)
RETURNS SETOF public.user_plugin_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret);
  RETURN QUERY
    SELECT * FROM public.user_plugin_settings ups
    WHERE ups.voter_id = p_client_id AND ups.plugin_id = p_plugin_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Playtime sessions (config_playtime)
-- ---------------------------------------------------------------------------
-- Inserts a session row and returns its id. Pass p_session_end and a
-- duration to record an already-finished session in one call.
CREATE OR REPLACE FUNCTION public.client_start_playtime(
  p_client_id text, p_secret text, p_app_id text, p_config_key text,
  p_proton_version text, p_source text, p_session_start timestamptz,
  p_session_end timestamptz DEFAULT NULL, p_duration_minutes integer DEFAULT 0)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret);
  IF coalesce(p_app_id, '') = '' OR p_session_start IS NULL THEN
    RAISE EXCEPTION 'app id and session start are required' USING ERRCODE = '22023';
  END IF;
  IF p_duration_minutes IS NULL OR p_duration_minutes < 0 OR p_duration_minutes > 1440 * 7 THEN
    RAISE EXCEPTION 'duration out of range' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.config_playtime
    (voter_id, app_id, config_key, proton_version, source,
     session_start, session_end, duration_minutes)
  VALUES
    (p_client_id, p_app_id, p_config_key, p_proton_version, p_source,
     p_session_start, p_session_end, p_duration_minutes)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Closes one of this client's sessions. Returns false when the row is not
-- this client's (or does not exist).
CREATE OR REPLACE FUNCTION public.client_finish_playtime(
  p_client_id text, p_secret text, p_row_id bigint,
  p_session_end timestamptz, p_duration_minutes integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret);
  IF p_duration_minutes IS NULL OR p_duration_minutes < 0 OR p_duration_minutes > 1440 * 7 THEN
    RAISE EXCEPTION 'duration out of range' USING ERRCODE = '22023';
  END IF;
  UPDATE public.config_playtime
  SET session_end = p_session_end, duration_minutes = p_duration_minutes
  WHERE id = p_row_id AND voter_id = p_client_id;
  RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reports (user_configs)
-- ---------------------------------------------------------------------------
-- Upserts this client's report for p_report->>'app_id'. Only report content
-- columns are taken from p_report. Ownership (client_id,
-- proton_pulse_user_id, installation_id) is set here, and moderation state
-- (is_hidden, is_flagged, owner_verified, flags, anonymized_at) is never
-- writable by the caller. Returns the report id.
CREATE OR REPLACE FUNCTION public.client_submit_report(
  p_client_id text, p_secret text, p_installation_id text, p_report jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_user uuid := public.client_linked_user(p_installation_id, p_secret);
  r      public.user_configs;
  v_id   bigint;
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret, v_user);
  IF p_report IS NULL OR jsonb_typeof(p_report) <> 'object' THEN
    RAISE EXCEPTION 'report must be a JSON object' USING ERRCODE = '22023';
  END IF;

  r := jsonb_populate_record(NULL::public.user_configs, p_report);
  IF coalesce(r.app_id, '') = '' THEN
    RAISE EXCEPTION 'app_id is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_configs AS uc (
    client_id, proton_pulse_user_id, installation_id,
    app_id, title, cpu, gpu, gpu_driver, gpu_vendor, gpu_architecture, ram, os, kernel,
    proton_version, duration, duration_minutes, rating, notes, launch_options,
    enabled_vars, confidence_score, source, app_type, config_key, vram_mb, cpu_cores,
    display_resolution, steam_deck_model, form_responses, play_mode, vr_runtime,
    vr_device, game_owned, fps_min, fps_avg, fps_max, run_type)
  VALUES (
    p_client_id, v_user, p_installation_id,
    r.app_id, r.title, r.cpu, r.gpu, coalesce(r.gpu_driver, ''), coalesce(r.gpu_vendor, 'other'),
    r.gpu_architecture, r.ram, r.os, coalesce(r.kernel, ''),
    r.proton_version, coalesce(r.duration, 'unreported'), r.duration_minutes, r.rating,
    coalesce(r.notes, ''), coalesce(r.launch_options, ''),
    coalesce(r.enabled_vars, '{}'::jsonb), r.confidence_score, coalesce(r.source, 'user'),
    coalesce(r.app_type, 'steam'), r.config_key, r.vram_mb, r.cpu_cores,
    r.display_resolution, r.steam_deck_model, r.form_responses, r.play_mode, r.vr_runtime,
    r.vr_device, coalesce(r.game_owned, false), r.fps_min, r.fps_avg, r.fps_max, r.run_type)
  ON CONFLICT (client_id, app_id) DO UPDATE SET
    proton_pulse_user_id = EXCLUDED.proton_pulse_user_id,
    installation_id      = EXCLUDED.installation_id,
    title = EXCLUDED.title, cpu = EXCLUDED.cpu, gpu = EXCLUDED.gpu,
    gpu_driver = EXCLUDED.gpu_driver, gpu_vendor = EXCLUDED.gpu_vendor,
    gpu_architecture = EXCLUDED.gpu_architecture, ram = EXCLUDED.ram, os = EXCLUDED.os,
    kernel = EXCLUDED.kernel, proton_version = EXCLUDED.proton_version,
    duration = EXCLUDED.duration, duration_minutes = EXCLUDED.duration_minutes,
    rating = EXCLUDED.rating, notes = EXCLUDED.notes, launch_options = EXCLUDED.launch_options,
    enabled_vars = EXCLUDED.enabled_vars, confidence_score = EXCLUDED.confidence_score,
    source = EXCLUDED.source, app_type = EXCLUDED.app_type, config_key = EXCLUDED.config_key,
    vram_mb = EXCLUDED.vram_mb, cpu_cores = EXCLUDED.cpu_cores,
    display_resolution = EXCLUDED.display_resolution,
    steam_deck_model = EXCLUDED.steam_deck_model, form_responses = EXCLUDED.form_responses,
    play_mode = EXCLUDED.play_mode, vr_runtime = EXCLUDED.vr_runtime,
    vr_device = EXCLUDED.vr_device, game_owned = EXCLUDED.game_owned,
    fps_min = EXCLUDED.fps_min, fps_avg = EXCLUDED.fps_avg, fps_max = EXCLUDED.fps_max,
    run_type = EXCLUDED.run_type
  RETURNING uc.id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.client_delete_report(
  p_client_id text, p_secret text, p_app_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret);
  DELETE FROM public.user_configs WHERE client_id = p_client_id AND app_id = p_app_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: only the public RPCs are callable by API roles.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.client_cast_vote(text, text, text, text, smallint)',
    'public.client_save_cloud_config(text, text, text, bigint, text, text, jsonb)',
    'public.client_delete_cloud_config(text, text, bigint, text)',
    'public.client_my_cloud_configs(text, text, text)',
    'public.client_save_plugin_settings(text, text, text, jsonb)',
    'public.client_my_plugin_settings(text, text, text)',
    'public.client_start_playtime(text, text, text, text, text, text, timestamptz, timestamptz, integer)',
    'public.client_finish_playtime(text, text, bigint, timestamptz, integer)',
    'public.client_submit_report(text, text, text, jsonb)',
    'public.client_delete_report(text, text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', fn);
  END LOOP;
END;
$$;
