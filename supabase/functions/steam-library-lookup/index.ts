// steam-library-lookup: admin-only proxy for keyed Steam Web API endpoints.
//
// Public Steam endpoints already have a proxy (steam-explore, verify_jwt=false).
// The three below require the Steam Web API key, so we:
//   1. Verify the caller's JWT.
//   2. Check the manage_admins permission via current_user_has_permission RPC.
//   3. Only then attach the key and hit Steam.
//
// The key never leaves the server. Response shape mirrors steam-explore so the
// API Explorer renders it the same way.
//
// Endpoints (see issue #221):
//   steam_get_owned_games         IPlayerService/GetOwnedGames/v1/
//   steam_get_recently_played     IPlayerService/GetRecentlyPlayedGames/v1/
//   steam_resolve_vanity          ISteamUser/ResolveVanityURL/v1/
//
// Env:
//   STEAM_WEB_API_KEY  - get at https://steamcommunity.com/dev/apikey

import { createRequestAuthClient } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Envelope = {
  ok: boolean;
  endpoint: string;
  arg: string;
  url: string;
  method: string;
  status?: number;
  data?: unknown;
  error?: string;
};

// Which endpoint key maps to which upstream URL builder + arg name. Anything
// not in this map is rejected before we touch Steam so we cannot be tricked
// into forwarding arbitrary requests via the admin key.
const ENDPOINTS: Record<
  string,
  { argName: "steamid" | "vanityurl"; build: (arg: string, key: string) => string }
> = {
  steam_get_owned_games: {
    argName: "steamid",
    // include_appinfo=1 gives us titles + img_icon_url. include_played_free_games=1
    // includes F2P titles the account has actually launched (Dota 2, TF2, etc).
    build: (steamid, key) =>
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` +
      `?key=${encodeURIComponent(key)}` +
      `&steamid=${encodeURIComponent(steamid)}` +
      `&include_appinfo=1&include_played_free_games=1&format=json`,
  },
  steam_get_recently_played: {
    argName: "steamid",
    // count=0 = all recently played (Steam caps at ~10-20). Explicit for clarity.
    build: (steamid, key) =>
      `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/` +
      `?key=${encodeURIComponent(key)}` +
      `&steamid=${encodeURIComponent(steamid)}` +
      `&count=0&format=json`,
  },
  steam_resolve_vanity: {
    argName: "vanityurl",
    // url_type=1 = individual profile. Steam also supports group (2) and
    // official game group (3), but the Explorer only needs profiles.
    build: (vanity, key) =>
      `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/` +
      `?key=${encodeURIComponent(key)}` +
      `&vanityurl=${encodeURIComponent(vanity)}` +
      `&url_type=1&format=json`,
  },
};

// Steam vanity URLs are alphanumerics + underscore + hyphen. Steam IDs are 17
// digits (76561...). Loose regexes here just guard against injecting `&` or
// path segments into the upstream URL; Steam does the real validation.
const STEAMID_RE = /^\d{5,20}$/;
const VANITY_RE = /^[A-Za-z0-9_-]{2,64}$/;

function jsonResponse(body: Envelope, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse(
      { ok: false, endpoint: "", arg: "", url: "", method: "", error: "POST required" },
      405,
    );
  }

  let payload: { endpoint?: string; steamid?: string; vanityurl?: string } = {};
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(
      { ok: false, endpoint: "", arg: "", url: "", method: "POST", error: "invalid JSON body" },
      400,
    );
  }

  const endpoint = String(payload.endpoint || "");
  const meta = ENDPOINTS[endpoint];
  if (!meta) {
    return jsonResponse(
      { ok: false, endpoint, arg: "", url: "", method: "POST", error: "unknown endpoint" },
      400,
    );
  }

  // Verify caller is a signed-in admin with manage_admins. RLS + edge-fn side
  // gate. Same shape as image-refetch's _requireAdmin (#175).
  const authClient = createRequestAuthClient(req);
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) {
    return jsonResponse(
      { ok: false, endpoint, arg: "", url: "", method: "GET", error: "authentication required" },
      401,
    );
  }
  const { data: hasPerm, error: rpcErr } = await authClient
    .rpc("current_user_has_permission", { p: "manage_admins" });
  if (rpcErr) {
    return jsonResponse(
      { ok: false, endpoint, arg: "", url: "", method: "GET", error: `permission check: ${rpcErr.message}` },
      500,
    );
  }
  if (!hasPerm) {
    return jsonResponse(
      { ok: false, endpoint, arg: "", url: "", method: "GET", error: "manage_admins permission required" },
      403,
    );
  }

  const rawArg = meta.argName === "steamid"
    ? String(payload.steamid || "").trim()
    : String(payload.vanityurl || "").trim();
  if (!rawArg) {
    return jsonResponse(
      { ok: false, endpoint, arg: "", url: "", method: "GET", error: `${meta.argName} is required` },
      400,
    );
  }
  const argOk = meta.argName === "steamid" ? STEAMID_RE.test(rawArg) : VANITY_RE.test(rawArg);
  if (!argOk) {
    return jsonResponse(
      { ok: false, endpoint, arg: rawArg, url: "", method: "GET", error: `invalid ${meta.argName} format` },
      400,
    );
  }

  const apiKey = Deno.env.get("STEAM_WEB_API_KEY");
  if (!apiKey) {
    console.error(`[steam-library-lookup] STEAM_WEB_API_KEY not configured`);
    return jsonResponse(
      { ok: false, endpoint, arg: rawArg, url: "", method: "GET", error: "server misconfigured: missing STEAM_WEB_API_KEY" },
      500,
    );
  }

  const url = meta.build(rawArg, apiKey);
  // Never expose the api key back to the client via the response envelope.
  const safeUrl = url.replace(encodeURIComponent(apiKey), "***");
  try {
    const upstream = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await upstream.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }
    console.log(`[steam-library-lookup] endpoint=${endpoint} arg=${rawArg} status=${upstream.status} source=steamworks`);
    return jsonResponse(
      {
        ok: upstream.ok,
        endpoint,
        arg: rawArg,
        url: safeUrl,
        method: "GET",
        status: upstream.status,
        data,
        error: upstream.ok ? undefined : `Steam HTTP ${upstream.status}`,
      },
      200,
    );
  } catch (e) {
    console.error(`[steam-library-lookup] endpoint=${endpoint} arg=${rawArg} network error=${(e as Error).message}`);
    return jsonResponse(
      { ok: false, endpoint, arg: rawArg, url: safeUrl, method: "GET", error: `network: ${(e as Error).message}` },
      502,
    );
  }
});
