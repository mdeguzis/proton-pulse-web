import { isRateLimited, getClientIp, rateLimitResponse } from "../_shared/rateLimit.ts";
// steam-news: CORS proxy for ISteamNews/GetNewsForApp.
//
// This is our "when was the game last updated" fallback for apps that
// the steamcmd PICS pipeline (#215) has not cached yet. The Steamworks
// Web API endpoint is public HTTP but does not send an
// Access-Control-Allow-Origin header to third-party origins, so a
// direct browser fetch is blocked. This function forwards the request
// server-side and re-serves it with an open CORS header + 10 min cache.
//
// Trade-offs the caller should know about (Metadata modal is the main
// consumer):
//   - This surfaces the most recent patch note timestamp, not a
//     per-OS depot manifest date. Devs who skip news for silent patches
//     leave a gap.
//   - No first-seen date. That data only exists in PICS.
//
// The steamcmd pipeline still wins when it has data for the app; the
// modal only falls through to this endpoint on a PICS cache miss.
//
// Public (verify_jwt = false). #219 filed for a longer-term SteamKit
// listener that would eliminate the fallback entirely.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (isRateLimited("steam-news", getClientIp(req))) return rateLimitResponse(corsHeaders);

  const url = new URL(req.url);
  const appId = (url.searchParams.get("appId") || "").trim();
  if (!/^\d+$/.test(appId)) {
    return Response.json(
      { error: "appId must be a numeric Steam app ID" },
      { status: 400, headers: corsHeaders },
    );
  }
  const count = Math.max(1, Math.min(20, Number(url.searchParams.get("count") || "5") | 0));
  const maxlength = Math.max(0, Math.min(2000, Number(url.searchParams.get("maxlength") || "300") | 0));

  const upstream = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=${count}&maxlength=${maxlength}`;
  try {
    const r = await fetch(upstream, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      console.log(`[steam-news] appId=${appId} upstream=${r.status} source=steam-news-error`);
      return Response.json(
        { appId, found: false, error: `Steam upstream ${r.status}` },
        { status: 502, headers: corsHeaders },
      );
    }
    const body = await r.json();
    const items = Array.isArray(body?.appnews?.newsitems) ? body.appnews.newsitems : [];
    if (items.length === 0) {
      console.log(`[steam-news] appId=${appId} found=false source=steam-news-empty`);
      return Response.json(
        { appId, found: false, items: [] },
        { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
      );
    }
    // Reshape to the compact shape the Metadata modal wants.
    const compact = items.map((it: Record<string, unknown>) => ({
      title:      it.title      ?? null,
      url:        it.url        ?? null,
      author:     it.author     ?? null,
      date:       typeof it.date === "number" ? it.date : null,
      feedlabel:  it.feedlabel  ?? null,
      contents:   typeof it.contents === "string" ? String(it.contents).slice(0, 400) : null,
    }));
    const newest = compact[0]?.date ?? null;
    console.log(`[steam-news] appId=${appId} count=${compact.length} newest=${newest} source=steam-news-ok`);
    return Response.json(
      { appId, found: true, items: compact, newest_ts: newest },
      { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[steam-news] appId=${appId} error=${msg} url=${upstream}`);
    return Response.json(
      { appId, found: false, error: msg },
      { status: 502, headers: corsHeaders },
    );
  }
});
