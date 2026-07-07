// steam-depot-info: per-OS depot last-updated dates for the Metadata modal.
//
// Reads from public.steam_depot_updates (populated nightly by the Steam
// PICS pipeline via steamcmd; see .github/workflows/steam-metadata-fetch.yml).
// Aggregates rows into a compact { windows, mac, linux } shape:
//
//   { appId: "367520", found: true, os: {
//       linux:   { first_seen: "...", last_updated: "...", depots: 1 },
//       ...
//     }}
//
// When no rows exist for the app yet the response is { found: false }
// so the frontend can fall through to the SteamDB deep-link fallback
// without treating a cache miss as an error.
//
// Public (verify_jwt = false). Read-only. #215.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type Row = {
  app_id: number;
  os: string;
  depot_id: number;
  last_updated_at: string;
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return Response.json(
      { error: "server misconfigured" },
      { status: 500, headers: corsHeaders },
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from("steam_depot_updates")
    .select("app_id,os,depot_id,last_updated_at")
    .eq("app_id", Number(appId));

  if (error) {
    console.error(`[steam-depot-info] appId=${appId} query error=${error.message}`);
    return Response.json(
      { error: error.message, appId },
      { status: 502, headers: corsHeaders },
    );
  }
  const rows = (data as Row[]) || [];
  if (rows.length === 0) {
    console.log(`[steam-depot-info] appId=${appId} found=false source=cache-miss`);
    return Response.json(
      { appId, found: false, os: {} },
      { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
    );
  }

  // Reduce to per-OS min / max timestamps + depot count.
  type Bucket = { first: number; last: number; depots: Set<number> };
  const byOs = new Map<string, Bucket>();
  for (const row of rows) {
    const ts = Date.parse(row.last_updated_at);
    if (!Number.isFinite(ts)) continue;
    let b = byOs.get(row.os);
    if (!b) { b = { first: ts, last: ts, depots: new Set() }; byOs.set(row.os, b); }
    if (ts < b.first) b.first = ts;
    if (ts > b.last)  b.last  = ts;
    b.depots.add(row.depot_id);
  }
  const os: Record<string, { first_seen: string; last_updated: string; depots: number }> = {};
  for (const [key, b] of byOs.entries()) {
    os[key] = {
      first_seen:   new Date(b.first).toISOString(),
      last_updated: new Date(b.last).toISOString(),
      depots:       b.depots.size,
    };
  }
  console.log(`[steam-depot-info] appId=${appId} found=true osCount=${Object.keys(os).length} source=cache`);
  return Response.json(
    { appId, found: true, os },
    { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
  );
});
