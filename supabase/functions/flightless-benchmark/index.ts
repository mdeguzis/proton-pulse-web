import { isRateLimited, getClientIp, rateLimitResponse } from "../_shared/rateLimit.ts";
// flightless-benchmark: CORS proxy for FlightlessSomething's per-benchmark
// stats endpoint (#410).
//
// FlightlessSomething's REST API sends no Access-Control-Allow-Origin
// header, so the browser cannot fetch /api/benchmarks/:id/data from our
// origin (the "Show data & graphs" expansion on game-stats.html). This
// function fetches server-side and re-serves with an open CORS header,
// exactly like protondb-summary.
//
// Public (verify_jwt = false). Read-only, no database access. The caller
// is hostile by assumption: the only input is a numeric benchmark id, and
// the upstream is a fixed endpoint map -- no arbitrary URL proxying.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (isRateLimited("flightless-benchmark", getClientIp(req))) return rateLimitResponse(corsHeaders);

  const url = new URL(req.url);
  const benchId = (url.searchParams.get("id") || "").trim();
  if (!/^\d{1,10}$/.test(benchId)) {
    return Response.json(
      { error: "id must be a numeric FlightlessSomething benchmark id" },
      { status: 400, headers: corsHeaders },
    );
  }

  const upstreamUrl = `https://flightlesssomething.ambrosia.one/api/benchmarks/${benchId}/data`;
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "proton-pulse-web/1.0 (+https://www.proton-pulse.com)",
      },
    });

    if (upstream.status === 404) {
      console.log(`[flightless-benchmark] id=${benchId} found=false source=fs-404`);
      return Response.json(
        { id: benchId, found: false },
        { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=3600" } },
      );
    }

    if (!upstream.ok) {
      console.log(`[flightless-benchmark] id=${benchId} upstreamStatus=${upstream.status} source=fs-error`);
      return Response.json(
        { error: `FlightlessSomething upstream returned ${upstream.status}`, id: benchId, found: false },
        { status: 502, headers: corsHeaders },
      );
    }

    const data = await upstream.json();
    const runCount = Array.isArray(data) ? data.length : (data?.runs?.length ?? 0);
    console.log(`[flightless-benchmark] id=${benchId} found=true runs=${runCount} source=fs-api`);
    // Benchmark data is immutable once uploaded -- cache aggressively so
    // repeated expansions of a popular benchmark never re-hit their API.
    return Response.json(
      data,
      { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=86400" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[flightless-benchmark] id=${benchId} error=${msg} url=${upstreamUrl}`);
    return Response.json(
      { error: msg, id: benchId, found: false },
      { status: 502, headers: corsHeaders },
    );
  }
});
