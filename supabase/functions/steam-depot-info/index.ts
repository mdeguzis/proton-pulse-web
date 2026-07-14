import { isRateLimited, getClientIp, rateLimitResponse } from "../_shared/rateLimit.ts";
// steam-depot-info: per-OS depot last-updated + tracked-since dates for
// the Metadata modal.
//
// Sources (both populated by the Steam PICS pipeline via steamcmd; see
// .github/workflows/steam-metadata-fetch.yml):
//   - public.steam_depot_updates          -> current per-OS depot rollup
//   - public.steam_depot_manifest_history -> earliest observation per OS
//                                            (#226 -- honest tracked_since)
//
// Response:
//   { appId: "367520", found: true, os: {
//       linux:   { tracked_since: "...", last_updated: "...", depots: 1 },
//       ...
//     }}
//
// When no rows exist for the app yet the response is { found: false }
// so the frontend can fall through to the SteamDB deep-link fallback
// without treating a cache miss as an error.
//
// tracked_since is only reported when we have real manifest history for
// that OS -- we deliberately do NOT fall back to last_updated_at because
// that was previously mistaken for a first-seen date. Better to show a
// dash than to lie. #237.
//
// Public (verify_jwt = false). Read-only. #215.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type UpdateRow = {
  app_id: number;
  os: string;
  depot_id: number;
  last_updated_at: string;
};
type HistoryRow = {
  app_id: number;
  os: string;
  depot_id: number;
  first_observed_at: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (isRateLimited("steam-depot-info", getClientIp(req))) return rateLimitResponse(corsHeaders);

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
  const [updatesRes, historyRes] = await Promise.all([
    supabase
      .from("steam_depot_updates")
      .select("app_id,os,depot_id,last_updated_at")
      .eq("app_id", Number(appId)),
    supabase
      .from("steam_depot_manifest_history")
      .select("app_id,os,depot_id,first_observed_at")
      .eq("app_id", Number(appId)),
  ]);

  if (updatesRes.error) {
    console.error(`[steam-depot-info] appId=${appId} updates error=${updatesRes.error.message}`);
    return Response.json(
      { error: updatesRes.error.message, appId },
      { status: 502, headers: corsHeaders },
    );
  }
  if (historyRes.error) {
    // History is optional -- log but keep going with just the update rollup.
    console.warn(`[steam-depot-info] appId=${appId} history query soft-failed error=${historyRes.error.message}`);
  }

  const updates = (updatesRes.data as UpdateRow[]) || [];
  const history = (historyRes.data as HistoryRow[]) || [];

  if (updates.length === 0 && history.length === 0) {
    console.log(`[steam-depot-info] appId=${appId} found=false source=cache-miss`);
    return Response.json(
      { appId, found: false, os: {} },
      { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
    );
  }

  // Per-OS aggregate: max last_updated_at from updates, min first_observed_at
  // from history, union of depot_ids for the count.
  type Bucket = { last: number; trackedSince: number | null; depots: Set<number> };
  const byOs = new Map<string, Bucket>();
  const bucket = (os: string): Bucket => {
    let b = byOs.get(os);
    if (!b) { b = { last: -Infinity, trackedSince: null, depots: new Set() }; byOs.set(os, b); }
    return b;
  };
  for (const row of updates) {
    const ts = Date.parse(row.last_updated_at);
    if (!Number.isFinite(ts)) continue;
    const b = bucket(row.os);
    if (ts > b.last) b.last = ts;
    b.depots.add(row.depot_id);
  }
  for (const row of history) {
    const ts = Date.parse(row.first_observed_at);
    if (!Number.isFinite(ts)) continue;
    const b = bucket(row.os);
    if (b.trackedSince === null || ts < b.trackedSince) b.trackedSince = ts;
    b.depots.add(row.depot_id);
  }

  const os: Record<string, { tracked_since: string | null; last_updated: string | null; depots: number }> = {};
  for (const [key, b] of byOs.entries()) {
    os[key] = {
      tracked_since: b.trackedSince != null ? new Date(b.trackedSince).toISOString() : null,
      last_updated:  Number.isFinite(b.last) ? new Date(b.last).toISOString() : null,
      depots:        b.depots.size,
    };
  }
  console.log(`[steam-depot-info] appId=${appId} found=true osCount=${Object.keys(os).length} source=cache`);
  return Response.json(
    { appId, found: true, os },
    { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
  );
});
