// public-steam-profile: anonymous Steam profile lookup for the /lookup page
// (#299). Accepts a Steam profile URL, vanity name, or 17-digit SteamID64 and
// returns the resolved SteamID64 plus the profile's owned-games list. No
// auth is required -- the whole point is to let users check a public profile
// without signing in, mirroring protondb.com/profile.
//
// The Steam Web API key never leaves the server. GetOwnedGames only returns
// data when the target profile has its games list visibility set to Public
// (or the caller is a friend, which is never the case here since the caller
// is us). A private or friends-only profile comes back as an empty games
// list; we surface that via `visibility` after a follow-up GetPlayerSummaries
// call so the UI can show a clear "This profile is private" message instead
// of a silent empty state.
//
// Env:
//   STEAM_API_KEY -- shared with the other keyed edge functions

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface OwnedGame {
  appid: number;
  name?: string;
  img_icon_url?: string;
  playtime_forever?: number;
  playtime_2weeks?: number;
}

interface PlayerSummary {
  steamid: string;
  personaname?: string;
  profileurl?: string;
  avatarfull?: string;
  // Steam: 1 = private/friends-only, 2 = friends-of-friends, 3 = public.
  communityvisibilitystate?: number;
  profilestate?: number;
}

interface Envelope {
  ok: boolean;
  steamId?: string;
  resolvedFrom?: "steamid" | "vanity" | "profile_url" | "vanity_url";
  profile?: {
    personaName?: string;
    profileUrl?: string;
    avatar?: string;
    // Simplified visibility flag; UI only needs to know "public vs not".
    isPublic: boolean;
  };
  games?: OwnedGame[];
  gameCount?: number;
  error?: string;
  errorCode?:
    | "invalid_input"
    | "missing_key"
    | "vanity_not_found"
    | "steam_network"
    | "steam_http";
}

// A 17-digit SteamID64 starts with "76561" but we accept any 17-digit numeric
// to match Steam's own tolerance. Vanity names are alphanumerics + underscore +
// hyphen, 2-64 chars, per Steam's URL rules.
const STEAMID_RE = /^\d{17}$/;
const VANITY_RE = /^[A-Za-z0-9_-]{2,64}$/;

// Pull the interesting segment out of a full profile URL. Handles both:
//   https://steamcommunity.com/profiles/76561198012345678[/anything]
//   https://steamcommunity.com/id/vanityname[/anything]
// Returns { kind, value } or null if the URL is not recognizable.
export function parseSteamProfileInput(raw: string):
  | { kind: "steamid"; value: string }
  | { kind: "vanity"; value: string }
  | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Raw SteamID64 shortcut.
  if (STEAMID_RE.test(trimmed)) return { kind: "steamid", value: trimmed };
  // Raw vanity name shortcut (no URL).
  if (VANITY_RE.test(trimmed) && !trimmed.includes("/")) {
    return { kind: "vanity", value: trimmed };
  }

  // URL path parsing. steamcommunity.com/profiles/{steamid} or /id/{vanity}.
  let host = "";
  let path = "";
  try {
    // Accept URLs that omit the scheme.
    const url = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    host = url.hostname.toLowerCase();
    path = url.pathname;
  } catch {
    return null;
  }
  if (host !== "steamcommunity.com" && host !== "www.steamcommunity.com") return null;

  const profilesMatch = path.match(/^\/profiles\/(\d{17})(?:\/|$)/);
  if (profilesMatch) return { kind: "steamid", value: profilesMatch[1] };

  const idMatch = path.match(/^\/id\/([A-Za-z0-9_-]{2,64})(?:\/|$)/);
  if (idMatch) return { kind: "vanity", value: idMatch[1] };

  return null;
}

function json(body: Envelope, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function resolveVanity(vanity: string, apiKey: string): Promise<{ steamId?: string; error?: string; errorCode?: Envelope["errorCode"] }> {
  const url =
    `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/` +
    `?key=${encodeURIComponent(apiKey)}` +
    `&vanityurl=${encodeURIComponent(vanity)}` +
    `&url_type=1&format=json`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return { error: `Steam HTTP ${res.status}`, errorCode: "steam_http" };
    }
    const body = await res.json();
    const success = body?.response?.success;
    if (success !== 1) {
      // success 42 = no match. Anything else = surface as "not found" since
      // Steam does not document additional codes for this endpoint.
      return { error: "No Steam profile found for that vanity URL", errorCode: "vanity_not_found" };
    }
    return { steamId: String(body.response.steamid || "") };
  } catch (e) {
    return { error: `Steam network: ${(e as Error).message}`, errorCode: "steam_network" };
  }
}

async function getOwnedGames(steamId: string, apiKey: string): Promise<{ games?: OwnedGame[]; count?: number; error?: string; errorCode?: Envelope["errorCode"] }> {
  const url =
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` +
    `?key=${encodeURIComponent(apiKey)}` +
    `&steamid=${encodeURIComponent(steamId)}` +
    `&include_appinfo=1&include_played_free_games=1&format=json`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return { error: `Steam HTTP ${res.status}`, errorCode: "steam_http" };
    }
    const body = await res.json();
    const games = Array.isArray(body?.response?.games) ? body.response.games : [];
    // game_count can be missing on private profiles (returns just {})
    const count = typeof body?.response?.game_count === "number" ? body.response.game_count : games.length;
    return { games, count };
  } catch (e) {
    return { error: `Steam network: ${(e as Error).message}`, errorCode: "steam_network" };
  }
}

async function getPlayerSummary(steamId: string, apiKey: string): Promise<PlayerSummary | null> {
  const url =
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/` +
    `?key=${encodeURIComponent(apiKey)}` +
    `&steamids=${encodeURIComponent(steamId)}` +
    `&format=json`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    const player = body?.response?.players?.[0];
    return player || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required", errorCode: "invalid_input" }, 405);

  let payload: { input?: string } = {};
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body", errorCode: "invalid_input" }, 400);
  }

  const parsed = parseSteamProfileInput(String(payload.input || ""));
  if (!parsed) {
    return json({
      ok: false,
      error: "Enter a Steam profile URL, vanity name, or 17-digit Steam ID",
      errorCode: "invalid_input",
    }, 400);
  }

  const apiKey = Deno.env.get("STEAM_API_KEY");
  if (!apiKey) {
    console.error(`[public-steam-profile] STEAM_API_KEY not configured`);
    return json({ ok: false, error: "Server misconfigured", errorCode: "missing_key" }, 500);
  }

  const resolvedFrom: Envelope["resolvedFrom"] =
    parsed.kind === "steamid" && payload.input?.includes("/") ? "profile_url"
    : parsed.kind === "steamid" ? "steamid"
    : payload.input?.includes("/") ? "vanity_url"
    : "vanity";

  let steamId = parsed.value;
  if (parsed.kind === "vanity") {
    const r = await resolveVanity(parsed.value, apiKey);
    if (!r.steamId) return json({ ok: false, error: r.error, errorCode: r.errorCode }, 404);
    steamId = r.steamId;
  }

  const [owned, summary] = await Promise.all([
    getOwnedGames(steamId, apiKey),
    getPlayerSummary(steamId, apiKey),
  ]);
  if (owned.error) {
    return json({ ok: false, steamId, error: owned.error, errorCode: owned.errorCode }, 502);
  }

  const isPublic = (summary?.communityvisibilitystate ?? 0) === 3;
  console.log(
    `[public-steam-profile] steamId=${steamId} resolved=${resolvedFrom} isPublic=${isPublic} gameCount=${owned.count ?? 0}`,
  );

  return json({
    ok: true,
    steamId,
    resolvedFrom,
    profile: {
      personaName: summary?.personaname,
      profileUrl: summary?.profileurl,
      avatar: summary?.avatarfull,
      isPublic,
    },
    games: owned.games,
    gameCount: owned.count,
  });
});
