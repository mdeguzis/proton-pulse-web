// protondb-summary: CORS proxy for the ProtonDB public summaries API.
//
// The browser cannot call protondb.com directly. Their summaries endpoint
// returns `access-control-allow-origin: https://www.protondb.com`, so any
// fetch from our static site (mdeguzis.github.io / proton-pulse.com) is blocked
// by the browser. This function fetches the summary server-side, where CORS
// does not apply, and re-serves it with an open CORS header so the "Check
// ProtonDB Live" button works for every game.
//
// Public (verify_jwt = false). Read-only, no database access.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const appId = (url.searchParams.get("appId") || "").trim();
  if (!/^\d+$/.test(appId)) {
    return Response.json(
      { error: "appId must be a numeric Steam app ID" },
      { status: 400, headers: corsHeaders },
    );
  }

  const upstreamUrl = `https://www.protondb.com/api/v1/reports/summaries/${appId}.json`;
  try {
    const upstream = await fetch(upstreamUrl, { headers: { Accept: "application/json" } });

    // ProtonDB 404s games it has no summary for. That is a normal "not found",
    // not an error, so report it distinctly with a 200 the frontend can read.
    if (upstream.status === 404) {
      console.log(`[protondb-summary] appId=${appId} found=false source=protondb-404`);
      return Response.json(
        { appId, found: false },
        { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
      );
    }

    if (!upstream.ok) {
      console.log(`[protondb-summary] appId=${appId} upstreamStatus=${upstream.status} source=protondb-error`);
      return Response.json(
        { error: `ProtonDB upstream returned ${upstream.status}`, appId, found: false },
        { status: 502, headers: corsHeaders },
      );
    }

    const data = await upstream.json();
    console.log(`[protondb-summary] appId=${appId} found=true tier=${data?.tier} total=${data?.total} source=protondb-api`);
    return Response.json(
      { appId, found: true, ...data },
      { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[protondb-summary] appId=${appId} error=${msg} url=${upstreamUrl}`);
    return Response.json(
      { error: msg, appId, found: false },
      { status: 502, headers: corsHeaders },
    );
  }
});
