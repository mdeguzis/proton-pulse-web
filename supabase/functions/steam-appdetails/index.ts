// steam-appdetails: CORS proxy for Steam's public appdetails endpoint.
//
// store.steampowered.com/api/appdetails does not send
// `access-control-allow-origin` back to third-party static origins like
// mdeguzis.github.io or proton-pulse.com, so a browser fetch is blocked
// (silent failure -> no platforms.linux -> Native Linux badge never
// appears, Metadata modal errors out). This function forwards the
// request server-side (where CORS does not apply) and re-serves the
// response with an open CORS header.
//
// Public (verify_jwt = false). Read-only, no database access. Cached for
// 10 minutes so a game page that renders 6 reports does not hammer
// Steam.

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
  // Passthrough of filters + language so callers can narrow the payload
  // if they know what they need. Default to no filter -> full response
  // (platforms, developers, publishers, genres, release_date, metacritic).
  const filters = url.searchParams.get("filters") || "";
  const lang    = url.searchParams.get("l")       || "english";
  const qs = new URLSearchParams({ appids: appId, l: lang });
  if (filters) qs.set("filters", filters);
  const upstreamUrl = `https://store.steampowered.com/api/appdetails?${qs.toString()}`;

  try {
    const upstream = await fetch(upstreamUrl, { headers: { Accept: "application/json" } });
    if (!upstream.ok) {
      console.log(`[steam-appdetails] appId=${appId} upstreamStatus=${upstream.status} source=steam-error`);
      return Response.json(
        { error: `Steam upstream returned ${upstream.status}`, appId },
        { status: 502, headers: corsHeaders },
      );
    }
    const body = await upstream.json();
    const entry = body?.[appId];
    if (!entry || entry.success !== true) {
      // Steam returns success:false for delisted / region-locked apps.
      // Surface a 200 with a clear shape so the frontend can distinguish
      // "Steam says no" from a network error.
      console.log(`[steam-appdetails] appId=${appId} steamSuccess=false source=steam-not-found`);
      return Response.json(
        { appId, success: false },
        { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
      );
    }
    console.log(`[steam-appdetails] appId=${appId} name=${entry?.data?.name ?? "unknown"} source=steam-ok`);
    // Re-serve with the same shape Steam uses ({ "<appId>": { success, data } })
    // so any client keyed on that structure keeps working.
    return Response.json(
      { [appId]: entry },
      { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[steam-appdetails] appId=${appId} error=${msg} url=${upstreamUrl}`);
    return Response.json(
      { error: msg, appId },
      { status: 502, headers: corsHeaders },
    );
  }
});
