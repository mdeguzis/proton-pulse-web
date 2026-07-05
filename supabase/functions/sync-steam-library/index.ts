/**
 * sync-steam-library - Supabase Edge Function
 *
 * Calls Steam's IPlayerService/GetOwnedGames for the signed-in user and caches
 * the appid list + count in public.user_steam_library. Powers the profile
 * Library section, the game-page ownership pill, and the home-page
 * library-rating breakdown chart (#199).
 *
 * Required env:
 *   STEAM_API_KEY
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { createServiceClient, requireRequestUser } from "../_shared/auth.ts";

const STEAM_API_BASE = "https://api.steampowered.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const { user, error: authError } = await requireRequestUser(req);
  if (!user) {
    return Response.json(
      { error: authError ?? "Authentication required" },
      { status: 401, headers: corsHeaders },
    );
  }

  const steamId = (user.user_metadata as Record<string, unknown> | null)
    ?.steam_id as string | undefined;
  if (!steamId) {
    return Response.json(
      { error: "Signed-in user has no linked Steam ID" },
      { status: 400, headers: corsHeaders },
    );
  }

  const steamApiKey = Deno.env.get("STEAM_API_KEY");
  if (!steamApiKey) {
    return Response.json(
      { error: "STEAM_API_KEY is not configured" },
      { status: 500, headers: corsHeaders },
    );
  }

  // include_played_free_games covers free titles the user has actually
  // launched; include_free_sub covers free titles always attached to the
  // account (Steam sub-based free games). Adding both to match ProtonDB's
  // count (#199 follow-up: user reported N-4 vs ProtonDB).
  const steamUrl =
    `${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/` +
    `?key=${steamApiKey}&steamid=${steamId}` +
    `&include_appinfo=false&include_played_free_games=true` +
    `&include_free_sub=true&skip_unvetted_apps=false&format=json`;

  let steamJson: {
    response?: { game_count?: number; games?: Array<{ appid: number }> };
  };
  try {
    const steamRes = await fetch(steamUrl);
    if (!steamRes.ok) {
      return Response.json(
        { error: `Steam API error: ${steamRes.status}` },
        { status: 502, headers: corsHeaders },
      );
    }
    steamJson = await steamRes.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Steam API fetch failed: ${message}` },
      { status: 502, headers: corsHeaders },
    );
  }

  const games = steamJson?.response?.games ?? [];
  const appids = games
    .map((g) => Number(g?.appid))
    .filter((n) => Number.isFinite(n) && n > 0);
  const gameCount = steamJson?.response?.game_count ?? appids.length;
  const syncedAt = new Date().toISOString();

  const supabase = createServiceClient();
  const { error: upsertError } = await supabase
    .from("user_steam_library")
    .upsert(
      {
        user_id: user.id,
        steam_id: steamId,
        game_count: gameCount,
        appids,
        synced_at: syncedAt,
      },
      { onConflict: "user_id" },
    );
  if (upsertError) {
    return Response.json(
      { error: `Failed to persist library: ${upsertError.message}` },
      { status: 500, headers: corsHeaders },
    );
  }

  return Response.json(
    {
      ok: true,
      game_count: gameCount,
      appid_count: appids.length,
      synced_at: syncedAt,
    },
    { headers: corsHeaders },
  );
});
