/**
 * sync-steam-wishlist - Supabase Edge Function (#266 Phase 1)
 *
 * Calls Steam's IWishlistService/GetWishlist for the signed-in user and
 * caches the appid list + count in public.user_steam_wishlist. Powers the
 * Wishlist filter chip on the home page: "show me reports for the games I
 * actually want to buy next."
 *
 * Mirrors sync-steam-library's shape so the auth + service-client story is
 * identical -- if that function keeps working, this one will too.
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

  // IWishlistService/GetWishlist returns { response: { items: [{appid, priority, date_added}, ...] } }
  // when the user's Steam privacy allows it. Users with fully private profiles
  // fail cleanly at the Steam layer with an empty items array; we cache the
  // empty state so the frontend can distinguish "not synced" from "synced empty."
  const steamUrl =
    `${STEAM_API_BASE}/IWishlistService/GetWishlist/v1/` +
    `?key=${steamApiKey}&steamid=${steamId}`;

  let steamJson: {
    response?: { items?: Array<{ appid?: number; priority?: number }> };
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

  const items = steamJson?.response?.items ?? [];
  // Preserve Steam's priority order (lower priority = higher on the list).
  const ordered = [...items].sort(
    (a, b) => (a?.priority ?? 999) - (b?.priority ?? 999),
  );
  const appids = ordered
    .map((it) => Number(it?.appid))
    .filter((n) => Number.isFinite(n) && n > 0);
  const itemCount = appids.length;
  const syncedAt = new Date().toISOString();

  const supabase = createServiceClient();
  const { error: upsertError } = await supabase
    .from("user_steam_wishlist")
    .upsert(
      {
        user_id: user.id,
        steam_id: steamId,
        item_count: itemCount,
        appids,
        synced_at: syncedAt,
      },
      { onConflict: "user_id" },
    );
  if (upsertError) {
    return Response.json(
      { error: `Failed to persist wishlist: ${upsertError.message}` },
      { status: 500, headers: corsHeaders },
    );
  }

  return Response.json(
    {
      ok: true,
      item_count: itemCount,
      synced_at: syncedAt,
    },
    { headers: corsHeaders },
  );
});
