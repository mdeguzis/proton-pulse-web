// image-refetch: server-side proxy for the admin Box Art Manager.
//
// The browser cannot call Steam's appdetails / SteamGridDB endpoints
// directly (no CORS headers), so this function does the calls
// server-side and returns the header URL plus a probe-verified status.
//
// Sources:
//   steam           - Steam appdetails (no auth)
//   sgdb            - SteamGridDB (needs SGDB_API_KEY)
//   set_override    - admin sets box_art_overrides.image_url (auth required)
//   upload_override - admin uploads image bytes to boxart storage bucket + writes override
//   clear_override  - admin deletes the override
//
// verify_jwt=false because the read-only proxy calls (steam, sgdb) do
// not require auth. Write ops verify the caller's JWT manually and
// require the manage_box_art permission (RLS enforces this too).
//
// See milestone: issue #175.

import { createRequestAuthClient, createServiceClient } from "../_shared/auth.ts";

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

// SteamGridDB search: returns a LIST of candidate grids for the admin to pick
// from, instead of auto-picking one. Resolves the game either by an editable
// title term (via /search/autocomplete/<term>, so trademark symbols in the
// store title can be stripped) or, when no term is given, by the Steam app id.
// Unlike _refetchSgdb it does NOT constrain dimensions, so games whose only
// community art is a non-460x215 size still return results.
type SgdbGrid = {
  id: number;
  url: string;
  thumb: string;
  width: number | null;
  height: number | null;
  style: string;
  mime: string;
  author: string;
};
type SgdbSearchOk = {
  ok: true;
  source: "sgdb_search";
  resolved_via: string;
  game: { id: number; name: string };
  results: SgdbGrid[];
};
type SgdbSearchFail = { ok: false; source: "sgdb_search"; error: string; status?: number };

async function _sgdbSearch(appId: string, term: string, dimensions: string): Promise<SgdbSearchOk | SgdbSearchFail> {
  const key = Deno.env.get("SGDB_API_KEY");
  if (!key) return { ok: false, source: "sgdb_search", error: "SGDB_API_KEY not configured on the server" };
  // Only allow digits, x, and comma through to the upstream query string.
  const dimSafe = /^[0-9x,]+$/.test(dimensions) ? dimensions : "";

  let gameId: number | null = null;
  let gameName = "";
  let via = "";
  const cleaned = (term || "").trim();
  if (cleaned) {
    // Title search. SGDB autocomplete returns games ranked by relevance.
    try {
      const r = await fetch(`${SGDB_BASE}/search/autocomplete/${encodeURIComponent(cleaned)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return { ok: false, source: "sgdb_search", status: r.status, error: `sgdb search HTTP ${r.status}` };
      const body = await r.json().catch(() => null);
      const first = body?.success && Array.isArray(body?.data) ? body.data[0] : null;
      if (!first?.id) return { ok: false, source: "sgdb_search", error: `no SteamGridDB match for "${cleaned}"` };
      gameId = first.id;
      gameName = first.name || cleaned;
      via = `search:${cleaned}`;
    } catch (e) {
      return { ok: false, source: "sgdb_search", error: `sgdb search: ${(e as Error).message}` };
    }
  } else {
    const lookup = await _sgdbGameId(appId, key);
    if (!lookup.id) return { ok: false, source: "sgdb_search", error: lookup.error || "sgdb no game id" };
    gameId = lookup.id;
    via = `steam-id:${appId}`;
  }

  let gridsRes: Response;
  try {
    // types=static excludes animated grids. dimensions is optional -- when
    // empty every static grid is returned; otherwise it is a comma-separated
    // allowlist (e.g. "460x215,920x430" for widescreen box-art shapes).
    const dimQuery = dimSafe ? `&dimensions=${dimSafe}` : "";
    gridsRes = await fetch(`${SGDB_BASE}/grids/game/${gameId}?types=static${dimQuery}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (e) {
    return { ok: false, source: "sgdb_search", error: `sgdb grids fetch: ${(e as Error).message}` };
  }
  if (!gridsRes.ok) return { ok: false, source: "sgdb_search", status: gridsRes.status, error: `sgdb grids HTTP ${gridsRes.status}` };
  const grids = await gridsRes.json().catch(() => null);
  if (!grids?.success || !Array.isArray(grids?.data)) {
    return { ok: false, source: "sgdb_search", error: "sgdb grids: bad response shape" };
  }
  const results: SgdbGrid[] = grids.data
    .slice(0, 30)
    .map((g: Record<string, unknown>) => ({
      id: Number(g.id) || 0,
      url: String(g.url || ""),
      thumb: String(g.thumb || g.url || ""),
      width: typeof g.width === "number" ? g.width : null,
      height: typeof g.height === "number" ? g.height : null,
      style: String(g.style || ""),
      mime: String(g.mime || ""),
      author: String((g.author as { name?: string } | undefined)?.name || ""),
    }))
    .filter((g: SgdbGrid) => g.url);
  if (!results.length) return { ok: false, source: "sgdb_search", error: "SteamGridDB returned no static grids for this game" };
  return { ok: true, source: "sgdb_search", resolved_via: via, game: { id: gameId, name: gameName }, results };
}

// Admin-only source dispatchers below. Each verifies the caller is an
// authenticated admin with the manage_box_art permission before touching
// box_art_overrides or the storage bucket.

type WriteOk = { ok: true; url: string; source: string; resolved_via: string };
type WriteFail = { ok: false; error: string; source: string; status?: number };

async function _requireAdmin(req: Request, source: string): Promise<{ userId: string } | WriteFail> {
  const authClient = createRequestAuthClient(req);
  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) {
    return { ok: false, source, status: 401, error: "authentication required" };
  }
  // Check manage_box_art permission via the shared helper. RLS also
  // enforces this on the tables/bucket, but checking here surfaces a
  // clearer 403 error to the admin UI.
  const { data: hasPerm, error: rpcErr } = await authClient
    .rpc("current_user_has_permission", { p: "manage_box_art" });
  if (rpcErr) {
    return { ok: false, source, status: 500, error: `permission check: ${rpcErr.message}` };
  }
  if (!hasPerm) {
    return { ok: false, source, status: 403, error: "manage_box_art permission required" };
  }
  return { userId: data.user.id };
}

async function _setOverride(req: Request, appId: string, url: string): Promise<WriteOk | WriteFail> {
  const auth = await _requireAdmin(req, "set_override");
  if ("ok" in auth) return auth;
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, source: "set_override", status: 400, error: "image_url must be an http(s) URL" };
  }
  // Verify URL loads before persisting so the admin doesn't stamp a
  // broken URL into the override map.
  try {
    const probe = await fetch(url, { method: "HEAD" });
    if (!probe.ok) {
      return { ok: false, source: "set_override", status: probe.status, error: `image URL HTTP ${probe.status}` };
    }
  } catch (e) {
    return { ok: false, source: "set_override", error: `image URL probe failed: ${(e as Error).message}` };
  }
  const svc = createServiceClient();
  const { error: upErr } = await svc.from("box_art_overrides").upsert({
    app_id: appId,
    image_url: url,
    source: "manual",
    set_by: auth.userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "app_id" });
  if (upErr) {
    return { ok: false, source: "set_override", status: 500, error: `db upsert: ${upErr.message}` };
  }
  console.log(`[image-refetch] source=set_override app=${appId} user=${auth.userId} url=${url}`);
  return { ok: true, source: "set_override", resolved_via: "manual", url };
}

async function _uploadOverride(req: Request, appId: string): Promise<WriteOk | WriteFail> {
  const auth = await _requireAdmin(req, "upload_override");
  if ("ok" in auth) return auth;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return { ok: false, source: "upload_override", status: 400, error: "file part required" };
  }
  // MIME allowlist enforced by bucket policy too; check here for a
  // friendlier error message.
  const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!ALLOWED.has(file.type)) {
    return { ok: false, source: "upload_override", status: 400, error: `unsupported mime "${file.type}"` };
  }
  if (file.size > 2_097_152) {
    return { ok: false, source: "upload_override", status: 400, error: `file too large (${file.size} bytes, max 2 MB)` };
  }
  // Namespace path by app_id + original extension. Overwrite semantics
  // via upsert so admins can replace without a separate delete step.
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const safeAppId = appId.replace(/[^A-Za-z0-9_:.-]/g, "_");
  const path = `${safeAppId}.${ext}`;
  const svc = createServiceClient();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: upErr } = await svc.storage.from("boxart").upload(path, bytes, {
    contentType: file.type,
    upsert: true,
  });
  if (upErr) {
    return { ok: false, source: "upload_override", status: 500, error: `storage upload: ${upErr.message}` };
  }
  const { data: pub } = svc.storage.from("boxart").getPublicUrl(path);
  const publicUrl = pub.publicUrl;
  const { error: dbErr } = await svc.from("box_art_overrides").upsert({
    app_id: appId,
    image_url: publicUrl,
    source: "upload",
    set_by: auth.userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "app_id" });
  if (dbErr) {
    return { ok: false, source: "upload_override", status: 500, error: `db upsert: ${dbErr.message}` };
  }
  console.log(`[image-refetch] source=upload_override app=${appId} user=${auth.userId} path=${path}`);
  return { ok: true, source: "upload_override", resolved_via: "upload", url: publicUrl };
}

async function _clearOverride(req: Request, appId: string): Promise<WriteOk | WriteFail> {
  const auth = await _requireAdmin(req, "clear_override");
  if ("ok" in auth) return auth;
  const svc = createServiceClient();
  // Best-effort delete of any uploaded blob before removing the DB row.
  // Storage isn't required to have anything at this path (manual URL
  // entries live in the DB only), so we ignore not-found errors here.
  for (const ext of ["png", "jpg", "webp"]) {
    const safeAppId = appId.replace(/[^A-Za-z0-9_:.-]/g, "_");
    await svc.storage.from("boxart").remove([`${safeAppId}.${ext}`]).catch(() => null);
  }
  const { error: delErr } = await svc.from("box_art_overrides").delete().eq("app_id", appId);
  if (delErr) {
    return { ok: false, source: "clear_override", status: 500, error: `db delete: ${delErr.message}` };
  }
  console.log(`[image-refetch] source=clear_override app=${appId} user=${auth.userId}`);
  return { ok: true, source: "clear_override", resolved_via: "cleared", url: "" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405, headers: corsHeaders });
  }

  // Upload uses multipart/form-data. All other sources use JSON.
  const contentType = req.headers.get("content-type") || "";
  const isMultipart = contentType.startsWith("multipart/form-data");
  let appId = "";
  let source = "steam";
  let overrideUrl = "";
  let searchTerm = "";
  let searchDims = "";
  if (isMultipart) {
    // Clone so downstream _uploadOverride can re-read the body.
    const clone = req.clone();
    const form = await clone.formData().catch(() => null);
    appId = String(form?.get("app_id") ?? "").trim();
    source = String(form?.get("source") ?? "upload_override").trim().toLowerCase();
  } else {
    let body: { app_id?: string; source?: string; url?: string; term?: string; dimensions?: string } | null = null;
    try { body = await req.json(); } catch { /* fall through */ }
    appId = String(body?.app_id ?? "").trim();
    source = String(body?.source ?? "steam").trim().toLowerCase();
    overrideUrl = String(body?.url ?? "").trim();
    searchTerm = String(body?.term ?? "").trim();
    searchDims = String(body?.dimensions ?? "").trim();
  }

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
  if (source === "sgdb_search") {
    const result = await _sgdbSearch(appId, searchTerm, searchDims);
    console.log(`[image-refetch] source=sgdb_search app=${appId} term="${searchTerm}" dims="${searchDims}" ok=${result.ok} ${result.ok ? `${result.results.length} results via ${result.resolved_via}` : result.error}`);
    return Response.json(result, { status: 200, headers: corsHeaders });
  }
  if (source === "set_override") {
    const result = await _setOverride(req, appId, overrideUrl);
    return Response.json(result, { status: result.ok ? 200 : (result.status || 400), headers: corsHeaders });
  }
  if (source === "upload_override") {
    const result = await _uploadOverride(req, appId);
    return Response.json(result, { status: result.ok ? 200 : (result.status || 400), headers: corsHeaders });
  }
  if (source === "clear_override") {
    const result = await _clearOverride(req, appId);
    return Response.json(result, { status: result.ok ? 200 : (result.status || 400), headers: corsHeaders });
  }
  return Response.json({ error: `unknown source "${source}"` }, { status: 400, headers: corsHeaders });
});
