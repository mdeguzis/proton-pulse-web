// search-games (#434): server-side full-text search over the search_index
// table. Replaces the 12MB client-side search-index.json blob so the search
// dropdown and grouped results page fetch ~2KB per query instead of a
// multi-megabyte JSON download on every page load.
//
// Wikipedia's OpenSearch model: client sends `?q=solo+leveling&store=all
// &include_delisted=false&limit=24`, server does the FTS + adult/delisted
// gate + store filter and returns ranked hits with hidden-row counts.
//
// verify_jwt = false: search is public, no session required. Per-IP rate
// limit keeps a single-source scraper from spamming us; the underlying
// tsvector index is fast enough that legitimate typing bursts stay well
// under the limit.
//
// Response shape (frontend contract in js/app/components/search.js):
//   {
//     results: [{ appId, title, tier, source, protondbCount, pulseCount,
//                 releaseYear, delisted, adult, replacedBy, steamType }],
//     total:            <count returned>,
//     hiddenDelisted:   <count of delisted rows suppressed by the pref>,
//     hiddenAdult:      <count of adult rows suppressed by the pref>,
//     query:            <normalized query echo>,
//     took_ms:          <server-side wall time>,
//   }

import { isRateLimited, getClientIp, rateLimitResponse } from "../_shared/rateLimit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=30",
};

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const VALID_STORES = new Set(["steam", "gog", "epic", "pgwiki", "all"]);
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

interface Row {
  app_id: string;
  title: string;
  tier: string | null;
  source: string;
  protondb_count: number | null;
  pulse_count: number | null;
  release_year: number | null;
  delisted: boolean | null;
  adult: boolean | null;
  replaced_by: string | null;
  steam_type: string | null;
}

function shapeRow(r: Row) {
  return {
    appId: r.app_id,
    title: r.title,
    tier: r.tier || "",
    source: r.source,
    protondbCount: r.protondb_count ?? 0,
    pulseCount: r.pulse_count ?? 0,
    releaseYear: r.release_year,
    delisted: r.delisted === true,
    adult: r.adult === true,
    replacedBy: r.replaced_by,
    steamType: r.steam_type,
  };
}

// Postgres full-text search via PostgREST's RPC or the raw table with
// `search_docs=fts.plainto.<query>` filter. We use the RPC pattern
// through an `and` filter so PostgREST can combine store/adult/delisted
// gates + `search_docs=fts.<q>` in one round trip.
async function fetchMatches(
  q: string,
  storeFilter: string,
  includeDelisted: boolean,
  includeAdult: boolean,
  limit: number,
): Promise<{ rows: Row[]; hiddenDelisted: number; hiddenAdult: number }> {
  const url = new URL(`${SB_URL}/rest/v1/search_index`);
  url.searchParams.set("select", "app_id,title,tier,source,protondb_count,pulse_count,release_year,delisted,adult,replaced_by,steam_type");
  // FTS: PostgREST's `fts` operator maps to `to_tsquery`, which requires
  // TS syntax (`half & life`) and 400s on plain input like "half life 2".
  // `plfts` maps to `plainto_tsquery`, which accepts free-form text and
  // ANDs the tokens itself -- the shape we want.
  const isNumeric = /^\d+$/.test(q);
  if (isNumeric) {
    // App id prefix match: `like.220*` translates to LIKE '220%'. The
    // dedicated text_pattern_ops index in the migration serves this.
    url.searchParams.set("app_id", `like.${q}*`);
  } else {
    url.searchParams.set("search_docs", `plfts(english).${q}`);
  }
  if (storeFilter !== "all") url.searchParams.set("source", `eq.${storeFilter}`);
  if (!includeDelisted) url.searchParams.set("delisted", "not.eq.true");
  if (!includeAdult) url.searchParams.set("adult", "not.eq.true");
  url.searchParams.set("limit", String(limit));
  // Order: rank by a rough proxy -- more reports = more relevant. FTS
  // rank would be ideal but PostgREST needs a computed column for that;
  // report count is a good-enough proxy and avoids a schema change.
  url.searchParams.set("order", "protondb_count.desc,pulse_count.desc,title.asc");

  const res = await fetch(url.toString(), {
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      Accept: "application/json",
      "Accept-Profile": "public",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`postgrest ${res.status}: ${body.slice(0, 200)}`);
  }
  const rows: Row[] = await res.json();

  // Compute hidden counts by re-running the same query WITHOUT the
  // delisted/adult filter, then diffing. Cheap because the same GIN
  // index serves both queries. Skipped when the pref is on -- nothing
  // is hidden so the count is definitionally zero.
  let hiddenDelisted = 0;
  let hiddenAdult = 0;
  if (!includeDelisted || !includeAdult) {
    const countUrl = new URL(url.toString());
    countUrl.searchParams.delete("delisted");
    countUrl.searchParams.delete("adult");
    countUrl.searchParams.set("select", "delisted,adult");
    countUrl.searchParams.set("limit", "1000"); // safe cap; hidden counts capped
    const cRes = await fetch(countUrl.toString(), {
      headers: {
        apikey: SB_SERVICE_KEY,
        Authorization: `Bearer ${SB_SERVICE_KEY}`,
        Accept: "application/json",
        "Accept-Profile": "public",
      },
    });
    if (cRes.ok) {
      const all: Array<{ delisted: boolean | null; adult: boolean | null }> = await cRes.json();
      if (!includeDelisted) hiddenDelisted = all.filter((r) => r.delisted === true).length;
      if (!includeAdult) hiddenAdult = all.filter((r) => r.adult === true).length;
    }
  }

  return { rows, hiddenDelisted, hiddenAdult };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (isRateLimited("search-games", getClientIp(req))) return rateLimitResponse(corsHeaders);

  const started = Date.now();
  const url = new URL(req.url);
  const rawQ = (url.searchParams.get("q") || "").trim();
  const store = (url.searchParams.get("store") || "all").toLowerCase();
  const includeDelisted = url.searchParams.get("include_delisted") === "true";
  const includeAdult = url.searchParams.get("include_adult") === "true";
  const rawLimit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(rawLimit))) : DEFAULT_LIMIT;

  // Guardrails: reject blank + oversize queries early. A 200-char query
  // would fill the URL bar with junk and the tsvector cost is O(q length)
  // per parse. 120 chars matches the search_query analytics cap.
  if (rawQ.length === 0) {
    return Response.json({ error: "q is required" }, { status: 400, headers: corsHeaders });
  }
  if (rawQ.length > 120) {
    return Response.json({ error: "q must be <= 120 chars" }, { status: 400, headers: corsHeaders });
  }
  if (!VALID_STORES.has(store)) {
    return Response.json({ error: `store must be one of: ${[...VALID_STORES].join(", ")}` }, { status: 400, headers: corsHeaders });
  }

  // FTS input sanitize: strip characters PostgREST fts operator treats as
  // syntax. `plainto_tsquery` in Postgres is safe against injection but
  // PostgREST parses the value as `fts(english).<literal>` where a stray
  // `&`, `|`, `!`, `(`, `)`, `:` would break the URL-level parse. Drop
  // them all; the tokenizer would ignore them anyway.
  const q = rawQ.replace(/[&|!():*<>?~+@]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) {
    return Response.json({ results: [], total: 0, hiddenDelisted: 0, hiddenAdult: 0, query: rawQ, took_ms: 0 }, { headers: corsHeaders });
  }

  try {
    const { rows, hiddenDelisted, hiddenAdult } = await fetchMatches(
      q, store, includeDelisted, includeAdult, limit,
    );
    const results = rows.map(shapeRow);
    const body = {
      results,
      total: results.length,
      hiddenDelisted,
      hiddenAdult,
      query: q,
      took_ms: Date.now() - started,
    };
    console.log(`[search-games] q=${JSON.stringify(q)} store=${store} results=${results.length} hidden={d:${hiddenDelisted},a:${hiddenAdult}} took=${body.took_ms}ms`);
    return Response.json(body, { headers: corsHeaders });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[search-games] q=${JSON.stringify(q)} error=${msg}`);
    return Response.json(
      { error: "search backend error", query: rawQ, took_ms: Date.now() - started },
      { status: 502, headers: corsHeaders },
    );
  }
});
