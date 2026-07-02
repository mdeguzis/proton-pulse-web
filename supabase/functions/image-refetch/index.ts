// image-refetch: server-side proxy for the admin Box Art Manager.
//
// The browser cannot call Steam's appdetails endpoint directly -- it
// returns no CORS headers so every fetch fails with `network: failed
// to fetch`. This function does the call server-side (no CORS applies)
// and returns the header_image URL plus a probe-verified status.
//
// Phase 2 will add source=sgdb (SteamGridDB); the endpoint shape is
// designed so adding a branch is a small change with no API contract
// break.
//
// Public (verify_jwt = false). Only writes are logs -- no database
// access. Rate limiting is out of scope for MVP; add if abuse arrives.
//
// See milestone: issue #175.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RefetchOk = {
  ok: true;
  url: string;
  source: "steam" | "sgdb";
  resolved_via: string;
};
type RefetchFail = {
  ok: false;
  error: string;
  status?: number;
  source: "steam" | "sgdb";
};

async function _refetchSteam(appId: string): Promise<RefetchOk | RefetchFail> {
  const upstreamUrl = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&filters=basic`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { headers: { Accept: "application/json" } });
  } catch (e) {
    return { ok: false, source: "steam", error: `network: ${(e as Error).message}` };
  }
  if (!upstream.ok) {
    return { ok: false, source: "steam", status: upstream.status, error: `appdetails HTTP ${upstream.status}` };
  }
  const body = await upstream.json().catch(() => null);
  const entry = body?.[appId];
  if (!entry || entry.success !== true) {
    return { ok: false, source: "steam", error: "appdetails returned unsuccessful (app removed or region-locked)" };
  }
  const header = entry?.data?.header_image;
  if (!header || typeof header !== "string") {
    return { ok: false, source: "steam", error: "appdetails returned no header_image" };
  }
  // Verify the URL Steam handed us actually resolves. Rare but happens
  // on limbo apps (appdetails reports a URL but the CDN 404s).
  try {
    const probe = await fetch(header, { method: "HEAD" });
    if (!probe.ok) {
      return { ok: false, source: "steam", status: probe.status, error: `header URL HTTP ${probe.status}` };
    }
  } catch (e) {
    return { ok: false, source: "steam", error: `header URL probe failed: ${(e as Error).message}` };
  }
  return { ok: true, source: "steam", resolved_via: "appdetails", url: header };
}

// SteamGridDB refetch. Handles Steam ids directly via /games/steam/<id>,
// and non-Steam ids (gog:*, epic:*) via /search/autocomplete/<title>.
// The API base is https://www.steamgriddb.com/api/v2. Requires
// SGDB_API_KEY set as a Supabase edge-function secret (get one at
// https://www.steamgriddb.com/profile/preferences/api).
const SGDB_BASE = "https://www.steamgriddb.com/api/v2";
// Header dimensions Steam uses. SGDB returns anything if we don't
// constrain; asking for the closest match keeps images from being
// squished into the card. static excludes animated grids.
const SGDB_GRID_QUERY = "?dimensions=460x215&types=static";

async function _sgdbGameId(appId: string, key: string): Promise<{ id: number | null; error?: string }> {
  const isSteam = /^\d+$/.test(appId);
  if (isSteam) {
    try {
      const r = await fetch(`${SGDB_BASE}/games/steam/${appId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return { id: null, error: `sgdb steam lookup HTTP ${r.status}` };
      const body = await r.json().catch(() => null);
      if (!body?.success || !body?.data?.id) return { id: null, error: "sgdb no match for Steam id" };
      return { id: body.data.id };
    } catch (e) {
      return { id: null, error: `sgdb steam lookup: ${(e as Error).message}` };
    }
  }
  // Non-Steam (gog:/epic:) don't have a first-class lookup; the caller
  // must supply a title via the app_id field for now. For MVP we bail
  // rather than autocomplete-guess.
  return { id: null, error: "sgdb non-Steam id lookup requires title-based search (not implemented yet)" };
}

async function _refetchSgdb(appId: string): Promise<RefetchOk | RefetchFail> {
  const key = Deno.env.get("SGDB_API_KEY");
  if (!key) {
    return { ok: false, source: "sgdb", error: "SGDB_API_KEY not configured on the server" };
  }
  const lookup = await _sgdbGameId(appId, key);
  if (!lookup.id) return { ok: false, source: "sgdb", error: lookup.error || "sgdb no game id" };

  // Fetch grids (Steam's header equivalent is 460x215 static).
  let gridsRes: Response;
  try {
    gridsRes = await fetch(`${SGDB_BASE}/grids/game/${lookup.id}${SGDB_GRID_QUERY}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (e) {
    return { ok: false, source: "sgdb", error: `sgdb grids fetch: ${(e as Error).message}` };
  }
  if (!gridsRes.ok) return { ok: false, source: "sgdb", status: gridsRes.status, error: `sgdb grids HTTP ${gridsRes.status}` };
  const grids = await gridsRes.json().catch(() => null);
  if (!grids?.success || !Array.isArray(grids?.data)) return { ok: false, source: "sgdb", error: "sgdb grids: bad response shape" };
  if (!grids.data.length) return { ok: false, source: "sgdb", error: "sgdb has no matching grids for this game" };
  // Prefer PNG over JPG (transparent + no lossy artifacts). Otherwise
  // top-voted, which SGDB returns first-order by default.
  const preferPng = grids.data.find((g: { mime?: string; url?: string }) => (g.mime || "").includes("png") && g.url);
  const pick = preferPng || grids.data[0];
  if (!pick?.url) return { ok: false, source: "sgdb", error: "sgdb grid entry has no url" };
  // Verify the picked URL actually resolves before claiming success.
  try {
    const probe = await fetch(pick.url, { method: "HEAD" });
    if (!probe.ok) return { ok: false, source: "sgdb", status: probe.status, error: `sgdb URL HTTP ${probe.status}` };
  } catch (e) {
    return { ok: false, source: "sgdb", error: `sgdb URL probe failed: ${(e as Error).message}` };
  }
  return { ok: true, source: "sgdb", resolved_via: `sgdb-grid#${lookup.id}`, url: pick.url };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405, headers: corsHeaders });
  }

  let body: { app_id?: string; source?: string } | null = null;
  try { body = await req.json(); } catch { /* fall through */ }
  const appId = String(body?.app_id ?? "").trim();
  const source = String(body?.source ?? "steam").trim().toLowerCase();

  if (!appId) {
    return Response.json({ error: "app_id required" }, { status: 400, headers: corsHeaders });
  }
  if (source === "steam") {
    if (!/^\d+$/.test(appId)) {
      return Response.json({ error: "steam app_id must be numeric" }, { status: 400, headers: corsHeaders });
    }
    const result = await _refetchSteam(appId);
    console.log(`[image-refetch] source=steam app=${appId} ok=${result.ok} ${result.ok ? result.resolved_via : result.error}`);
    return Response.json(result, { status: 200, headers: corsHeaders });
  }
  if (source === "sgdb") {
    const result = await _refetchSgdb(appId);
    console.log(`[image-refetch] source=sgdb app=${appId} ok=${result.ok} ${result.ok ? result.resolved_via : result.error}`);
    return Response.json(result, { status: 200, headers: corsHeaders });
  }
  return Response.json({ error: `unknown source "${source}"` }, { status: 400, headers: corsHeaders });
});
