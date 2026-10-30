-- Signed writes for the web site's anonymous client (#62).
--
-- The plugin proves it owns its client id with its installation secret
-- (client_verify, 20261030020000). The web site instead keeps an ECDSA
-- P-256 key pair in IndexedDB whose private key is created non-extractable,
-- so page scripts can sign with it but never read it. The client-write edge
-- function checks the signature and then calls client_web_write here with
-- the service role. Nothing in this file is callable by anon or
-- authenticated.
--
--   client_public_keys      one public key (JWK) per web client id, plus the
--                           last request timestamp (replay guard)
--   client_web_key          returns the stored key, registering the caller's
--                           key on first use if the id is free
--   client_web_write        replay check + ban check + the write itself
--
-- An id is only free for a web key if it has no installation secret and
-- has never been used by the plugin (cloud configs, plugin settings,
-- playtime, or a report tied to an installation). client_verify is
-- updated so the secret path refuses ids that hold a web key.

CREATE TABLE IF NOT EXISTS public.client_public_keys (
  client_id  text PRIMARY KEY,
  public_key jsonb NOT NULL,
  last_ts    bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.client_public_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_public_keys FROM anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Shared write bodies (used by the secret RPCs and the signed path)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.client_apply_vote(
  p_client_id text, p_app_id text, p_report_key text, p_vote smallint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_vote IS NULL OR p_vote NOT IN (-1, 0, 1) THEN
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

CREATE OR REPLACE FUNCTION public.client_apply_delete_cloud_config(
  p_client_id text, p_app_id bigint, p_profile_name text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.user_proton_configs
  WHERE voter_id = p_client_id
    AND app_id = p_app_id
    AND (nullif(btrim(p_profile_name), '') IS NULL OR profile_name = btrim(p_profile_name));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.client_apply_vote(text, text, text, smallint) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.client_apply_delete_cloud_config(text, bigint, text) FROM public, anon, authenticated;

-- The secret RPCs keep their signatures; their bodies now share the code
-- above.
CREATE OR REPLACE FUNCTION public.client_cast_vote(
  p_client_id text, p_secret text, p_app_id text, p_report_key text, p_vote smallint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret);
  PERFORM public.client_apply_vote(p_client_id, p_app_id, p_report_key, p_vote);
END;
$$;

CREATE OR REPLACE FUNCTION public.client_delete_cloud_config(
  p_client_id text, p_secret text, p_app_id bigint, p_profile_name text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  PERFORM public.client_verify(p_client_id, p_secret);
  RETURN public.client_apply_delete_cloud_config(p_client_id, p_app_id, p_profile_name);
END;
$$;

-- ---------------------------------------------------------------------------
-- Secret path refuses ids that hold a web key
-- ---------------------------------------------------------------------------
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
  IF EXISTS (SELECT 1 FROM public.client_public_keys WHERE client_id = p_client_id) THEN
    RAISE EXCEPTION 'client secret mismatch' USING ERRCODE = '42501';
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
REVOKE ALL ON FUNCTION public.client_verify(text, text, uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Web key registration + signed writes (service role only)
-- ---------------------------------------------------------------------------
-- Returns the public key stored for p_client_id. When none is stored and
-- p_public_key is given, registers it if the id is free. Raises otherwise.
CREATE OR REPLACE FUNCTION public.client_web_key(p_client_id text, p_public_key jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_key jsonb;
BEGIN
  IF p_client_id IS NULL OR p_client_id !~ '^[A-Za-z0-9-]{8,64}$' THEN
    RAISE EXCEPTION 'invalid client id' USING ERRCODE = '22023';
  END IF;

  SELECT public_key INTO v_key FROM public.client_public_keys WHERE client_id = p_client_id;
  IF v_key IS NOT NULL THEN
    RETURN v_key;
  END IF;

  IF p_public_key IS NULL
     OR p_public_key->>'kty' IS DISTINCT FROM 'EC'
     OR p_public_key->>'crv' IS DISTINCT FROM 'P-256'
     OR coalesce(p_public_key->>'x', '') = ''
     OR coalesce(p_public_key->>'y', '') = ''
     OR p_public_key ? 'd' THEN
    RAISE EXCEPTION 'a P-256 public key is required to register' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.client_secrets WHERE client_id = p_client_id)
     OR EXISTS (SELECT 1 FROM public.user_proton_configs WHERE voter_id = p_client_id)
     OR EXISTS (SELECT 1 FROM public.user_plugin_settings WHERE voter_id = p_client_id)
     OR EXISTS (SELECT 1 FROM public.config_playtime WHERE voter_id = p_client_id)
     OR EXISTS (SELECT 1 FROM public.user_configs
                WHERE client_id = p_client_id AND installation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'client id is not available for a web key' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.client_public_keys (client_id, public_key)
  VALUES (p_client_id, jsonb_build_object(
    'kty', 'EC', 'crv', 'P-256', 'x', p_public_key->>'x', 'y', p_public_key->>'y'))
  ON CONFLICT (client_id) DO NOTHING;

  SELECT public_key INTO v_key FROM public.client_public_keys WHERE client_id = p_client_id;
  RETURN v_key;
END;
$$;

-- Called by the client-write edge function after it verified the signature
-- against client_web_key. p_ts must be newer than the last accepted request
-- for this id, so a captured request cannot be replayed.
CREATE OR REPLACE FUNCTION public.client_web_write(
  p_client_id text, p_ts bigint, p_action text, p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  UPDATE public.client_public_keys SET last_ts = p_ts
  WHERE client_id = p_client_id AND last_ts < p_ts;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale or replayed request' USING ERRCODE = '42501';
  END IF;

  IF public.client_is_banned(p_client_id, NULL) THEN
    RAISE EXCEPTION 'client is banned' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'cast_vote' THEN
    PERFORM public.client_apply_vote(
      p_client_id, p_args->>'app_id', p_args->>'report_key', (p_args->>'vote')::smallint);
    RETURN jsonb_build_object('ok', true);
  ELSIF p_action = 'delete_cloud_config' THEN
    RETURN jsonb_build_object('ok', true, 'deleted',
      public.client_apply_delete_cloud_config(
        p_client_id, (p_args->>'app_id')::bigint, p_args->>'profile_name'));
  END IF;

  RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION public.client_web_key(text, jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.client_web_write(text, bigint, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_web_key(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.client_web_write(text, bigint, text, jsonb) TO service_role;
