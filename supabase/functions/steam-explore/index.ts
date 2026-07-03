// steam-explore: admin API Explorer proxy.
//
// Steam's public store endpoints are not CORS-enabled, so the admin panel
// cannot call them from the browser. This function fetches a whitelisted
// endpoint server-side and returns the raw JSON, so an admin can inspect a
// game's store metadata / Steam Deck verdict for manual debugging (issue #186).
//
// Read-only, whitelisted, numeric app id only. verify_jwt=false -- it exposes
// nothing beyond the public Steam responses.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Whitelisted endpoints. Key -> URL builder. Only these can be fetched.
const ENDPOINTS: Record<string, (id: string) => string> = {
  appdetails: (id) => `https://store.steampowered.com/api/appdetails?appids=${id}`,
  deck: (id) => `https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${id}`,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "POST only" }, { status: 405, headers: corsHeaders });
  }

  let body: { endpoint?: string; app_id?: string } | null = null;
  try { body = await req.json(); } catch { /* fall through */ }
  const endpoint = String(body?.endpoint ?? "").trim();
  const appId = String(body?.app_id ?? "").trim();

  if (!ENDPOINTS[endpoint]) {
    return Response.json(
      { ok: false, error: `unknown endpoint "${endpoint}" (allowed: ${Object.keys(ENDPOINTS).join(", ")})` },
      { status: 400, headers: corsHeaders },
    );
  }
  if (!/^\d+$/.test(appId)) {
    return Response.json({ ok: false, error: "app_id must be numeric" }, { status: 400, headers: corsHeaders });
  }

  const url = ENDPOINTS[endpoint](appId);
  try {
    const upstream = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await upstream.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    console.log(`[steam-explore] endpoint=${endpoint} app=${appId} status=${upstream.status}`);
    return Response.json(
      { ok: upstream.ok, endpoint, app_id: appId, url, status: upstream.status, data },
      { status: 200, headers: corsHeaders },
    );
  } catch (e) {
    return Response.json(
      { ok: false, endpoint, app_id: appId, url, error: `fetch failed: ${(e as Error).message}` },
      { status: 200, headers: corsHeaders },
    );
  }
});
