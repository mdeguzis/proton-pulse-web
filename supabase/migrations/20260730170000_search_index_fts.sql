-- #434 search API: Postgres-backed full-text search to replace the
-- 12MB search-index.json blob the client downloads today. Wikipedia's
-- OpenSearch model -- server does the matching, client fetches ~2KB
-- per query.
--
-- Table mirrors the columns pipeline finalize.py emits into
-- search-index.json (see js/app/lib/search-match.js + adult-filter.js +
-- delisted-filter.js for the column contract). Kept nullable per column
-- so a legacy row without release_year / adult flag can still upsert.
--
-- Sync is done by scripts/pipeline/finalize.py at end of run via a
-- batched upsert using the service-role key. Static search-index.json
-- stays on gh-pages as a fallback + archive.
--
-- Search path is a `search_docs` tsvector generated column with a GIN
-- index. Queries call `plainto_tsquery('english', $1)` so the caller
-- doesn't need to know FTS syntax.

CREATE TABLE IF NOT EXISTS public.search_index (
  app_id          text        PRIMARY KEY,
  title           text        NOT NULL,
  tier            text                 DEFAULT 'pending',
  source          text        NOT NULL,   -- 'steam' | 'gog' | 'epic' | 'pgwiki'
  protondb_count  integer              DEFAULT 0,
  pulse_count     integer              DEFAULT 0,
  release_year    integer,
  delisted        boolean              DEFAULT false,
  adult           boolean              DEFAULT false,
  replaced_by     text,
  steam_type      text,
  trend           text,
  updated_at      timestamptz          DEFAULT now(),
  -- Generated column: FTS document = title + app_id + tier + source. Weighted
  -- so title matches rank ahead of source/tier matches for the same query.
  search_docs     tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')),  'A') ||
      setweight(to_tsvector('english', coalesce(app_id, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(tier, '')),   'C') ||
      setweight(to_tsvector('english', coalesce(source, '')), 'C')
    ) STORED
);

-- GIN index on the tsvector -- the standard FTS acceleration structure.
CREATE INDEX IF NOT EXISTS search_index_docs_gin
  ON public.search_index USING gin (search_docs);

-- Ancillary btree indexes for the filter chain (store filter, delisted
-- default hide, adult default hide). Postgres query planner combines
-- these with the GIN index for cheap store/adult/delisted narrowing.
CREATE INDEX IF NOT EXISTS search_index_source_idx    ON public.search_index (source);
CREATE INDEX IF NOT EXISTS search_index_delisted_idx  ON public.search_index (delisted) WHERE delisted = true;
CREATE INDEX IF NOT EXISTS search_index_adult_idx     ON public.search_index (adult)    WHERE adult    = true;

-- Prefix-match acceleration for numeric appid queries. GIN on the tsvector
-- above matches whole tokens; a numeric prefix ("22" -> match 220, 2277,
-- 2200, ...) needs a separate index. text_pattern_ops enables LIKE 'X%'.
CREATE INDEX IF NOT EXISTS search_index_appid_prefix_idx
  ON public.search_index (app_id text_pattern_ops);

-- Row-level security: search is public, so anon and authenticated can
-- SELECT freely. Pipeline sync writes via service_role which bypasses
-- RLS entirely; no INSERT/UPDATE/DELETE policy is granted for anon
-- so a compromised anon key cannot poison the index.
ALTER TABLE public.search_index ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS search_index_public_select ON public.search_index;
CREATE POLICY search_index_public_select ON public.search_index
  FOR SELECT
  USING (true);

-- Grant explicit table-level privileges. RLS gates SELECT to the policy;
-- INSERT/UPDATE/DELETE stay service-role-only by default.
GRANT SELECT ON public.search_index TO anon, authenticated;
GRANT ALL    ON public.search_index TO service_role;

-- Comment for pgAdmin / builders exploring the schema.
COMMENT ON TABLE public.search_index IS
  'Full-text search index for site search (#434). Populated by pipeline finalize.py; queried by supabase/functions/search-games/. Kept in sync with search-index.json which stays as a fallback.';
