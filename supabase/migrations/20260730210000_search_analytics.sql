-- #434 followup: search API analytics. Every search-games invocation
-- records a row here so the admin analytics panel can show request
-- volume, latency percentiles, popular queries, and hit rate.
--
-- Kept small on purpose: no full query text retention beyond 30 days
-- (privacy + storage discipline). Ordered by ts DESC via a partial
-- index so the recent-first admin view stays fast without a full-table
-- sort on every read.

CREATE TABLE IF NOT EXISTS public.search_analytics (
  id                bigserial      PRIMARY KEY,
  ts                timestamptz    NOT NULL DEFAULT now(),
  query             text           NOT NULL,
  store             text                    DEFAULT 'all',
  result_count      integer                 DEFAULT 0,
  hidden_delisted   integer                 DEFAULT 0,
  hidden_adult      integer                 DEFAULT 0,
  took_ms           integer                 DEFAULT 0,
  include_delisted  boolean                 DEFAULT false,
  include_adult     boolean                 DEFAULT false,
  is_numeric        boolean                 DEFAULT false,
  status            text                    DEFAULT 'ok',   -- 'ok' | 'error' | 'ratelimit'
  error             text
);

CREATE INDEX IF NOT EXISTS search_analytics_ts_idx
  ON public.search_analytics (ts DESC);
CREATE INDEX IF NOT EXISTS search_analytics_query_idx
  ON public.search_analytics (query, ts DESC);

-- Retention. Auto-prune anything older than 30 days on a probabilistic
-- basis (one in every ~1000 inserts triggers the DELETE). Cheap enough
-- that no cron / scheduled function is needed, and self-healing if the
-- table ever grows unexpectedly.
CREATE OR REPLACE FUNCTION public.search_analytics_prune_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (random() < 0.001) THEN
    DELETE FROM public.search_analytics WHERE ts < now() - interval '30 days';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS search_analytics_prune ON public.search_analytics;
CREATE TRIGGER search_analytics_prune
AFTER INSERT ON public.search_analytics
FOR EACH ROW EXECUTE FUNCTION public.search_analytics_prune_trigger();

-- RLS: no anon/authenticated access at all. Edge fn writes via service_role
-- (bypasses RLS); admin reads via the SECURITY DEFINER RPC below.
ALTER TABLE public.search_analytics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.search_analytics FROM anon, authenticated;
GRANT ALL ON public.search_analytics TO service_role;

-- Admin RPC: aggregated stats for the analytics panel. Matches the
-- shape of public.admin_analytics() so the frontend can consume both
-- via the same auth check pattern.
CREATE OR REPLACE FUNCTION public.admin_search_analytics(days_back int DEFAULT 7)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_is_admin boolean;
  v_totals json;
  v_by_hour json;
  v_by_day json;
  v_top_queries json;
  v_top_zero_hit json;
  v_percentiles json;
  v_status_breakdown json;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.admins WHERE proton_pulse_user_id = auth.uid()
  ) INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Overall totals
  SELECT json_build_object(
    'total',            count(*),
    'unique_queries',   count(DISTINCT query),
    'avg_took_ms',      round(avg(took_ms)::numeric, 1),
    'total_hidden_delisted', coalesce(sum(hidden_delisted), 0),
    'total_hidden_adult',    coalesce(sum(hidden_adult), 0),
    'zero_hit_count',   count(*) FILTER (WHERE result_count = 0 AND status = 'ok')
  )
  INTO v_totals
  FROM public.search_analytics
  WHERE ts >= now() - (days_back || ' days')::interval;

  -- Hourly breakdown for the last 24h (bar chart)
  SELECT json_agg(r ORDER BY r.hour)
  INTO v_by_hour
  FROM (
    SELECT
      date_trunc('hour', ts)::timestamptz AS hour,
      count(*) AS requests,
      count(*) FILTER (WHERE status = 'error') AS errors,
      round(avg(took_ms)::numeric, 1) AS avg_took_ms
    FROM public.search_analytics
    WHERE ts >= now() - interval '24 hours'
    GROUP BY 1
    ORDER BY 1
  ) r;

  -- Daily breakdown for the requested window (line chart)
  SELECT json_agg(r ORDER BY r.day)
  INTO v_by_day
  FROM (
    SELECT
      date_trunc('day', ts)::date AS day,
      count(*) AS requests,
      count(*) FILTER (WHERE status = 'error') AS errors,
      round(avg(took_ms)::numeric, 1) AS avg_took_ms
    FROM public.search_analytics
    WHERE ts >= now() - (days_back || ' days')::interval
    GROUP BY 1
    ORDER BY 1
  ) r;

  -- Top queries by frequency
  SELECT json_agg(r ORDER BY r.requests DESC)
  INTO v_top_queries
  FROM (
    SELECT
      query,
      count(*) AS requests,
      round(avg(took_ms)::numeric, 1) AS avg_took_ms,
      round(avg(result_count)::numeric, 1) AS avg_results
    FROM public.search_analytics
    WHERE ts >= now() - (days_back || ' days')::interval
      AND length(query) > 0
    GROUP BY query
    ORDER BY count(*) DESC
    LIMIT 20
  ) r;

  -- Top zero-hit queries (searches that returned nothing -- content gap signal)
  SELECT json_agg(r ORDER BY r.attempts DESC)
  INTO v_top_zero_hit
  FROM (
    SELECT
      query,
      count(*) AS attempts
    FROM public.search_analytics
    WHERE ts >= now() - (days_back || ' days')::interval
      AND result_count = 0
      AND status = 'ok'
    GROUP BY query
    ORDER BY count(*) DESC
    LIMIT 20
  ) r;

  -- Latency percentiles (last 24h -- the interesting recent picture)
  SELECT json_build_object(
    'p50', round(percentile_cont(0.50) WITHIN GROUP (ORDER BY took_ms)::numeric, 1),
    'p95', round(percentile_cont(0.95) WITHIN GROUP (ORDER BY took_ms)::numeric, 1),
    'p99', round(percentile_cont(0.99) WITHIN GROUP (ORDER BY took_ms)::numeric, 1),
    'max', max(took_ms)
  )
  INTO v_percentiles
  FROM public.search_analytics
  WHERE ts >= now() - interval '24 hours';

  -- Status breakdown (ok / error / ratelimit)
  SELECT json_object_agg(status, cnt)
  INTO v_status_breakdown
  FROM (
    SELECT status, count(*) AS cnt
    FROM public.search_analytics
    WHERE ts >= now() - (days_back || ' days')::interval
    GROUP BY status
  ) r;

  RETURN json_build_object(
    'days_back',        days_back,
    'totals',           v_totals,
    'by_hour',          coalesce(v_by_hour, '[]'::json),
    'by_day',           coalesce(v_by_day, '[]'::json),
    'top_queries',      coalesce(v_top_queries, '[]'::json),
    'top_zero_hit',     coalesce(v_top_zero_hit, '[]'::json),
    'percentiles_24h',  v_percentiles,
    'status_breakdown', coalesce(v_status_breakdown, '{}'::json)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_search_analytics(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_search_analytics(integer) TO authenticated;

COMMENT ON TABLE public.search_analytics IS
  'Per-request log for the search-games edge fn (#434). Retention 30 days via probabilistic trigger. Read only via admin_search_analytics() RPC.';
