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

  // Two reads in parallel:
  //   depot_updates   -> current per-depot state (last_updated_at is the
  //                      branch-level timestamp; same across all OS depots
  //                      for a given app on the same branch).
  //   manifest_history -> Phase 2 observation table (#226). Every row is
  //                      a (app, depot, os, manifest_id) tuple we've ever
  //                      seen with first_observed_at + latest_observed_at.
  //                      Per-OS First seen  = MIN(first_observed_at).
  //                      Per-OS Last update = MAX(first_observed_at)
  //                      (a fresh manifest_id observation means a build
  //                      shipped for that OS).
  const [depotRes, historyRes] = await Promise.all([
    supabase
      .from("steam_depot_updates")
      .select("app_id,os,depot_id,last_updated_at")
      .eq("app_id", Number(appId)),
    supabase
      .from("steam_depot_manifest_history")
      .select("os,depot_id,manifest_id,first_observed_at,latest_observed_at")
      .eq("app_id", Number(appId)),
  ]);

  if (depotRes.error) {
    console.error(`[steam-depot-info] appId=${appId} depot query error=${depotRes.error.message}`);
    return Response.json(
      { error: depotRes.error.message, appId },
      { status: 502, headers: corsHeaders },
    );
  }
  const rows = (depotRes.data as Row[]) || [];
  if (rows.length === 0) {
    console.log(`[steam-depot-info] appId=${appId} found=false source=cache-miss`);
    return Response.json(
      { appId, found: false, os: {} },
      { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
    );
  }
  // History failure is non-fatal -- we can still return branch-level
  // dates for both first_seen and last_updated as a degraded fallback,
  // same shape as pre-#226. Log it so we notice.
  const history = !historyRes.error && Array.isArray(historyRes.data)
    ? (historyRes.data as {
        os: string; depot_id: number; manifest_id: string;
        first_observed_at: string; latest_observed_at: string;
      }[])
    : [];
  if (historyRes.error) {
    console.error(`[steam-depot-info] appId=${appId} history query error=${historyRes.error.message}`);
  }

  // Depot counts + branch fallback come from steam_depot_updates.
  type Bucket = { branchTs: number; depots: Set<number> };
  const byOs = new Map<string, Bucket>();
  for (const row of rows) {
    const ts = Date.parse(row.last_updated_at);
    if (!Number.isFinite(ts)) continue;
    let b = byOs.get(row.os);
    if (!b) { b = { branchTs: ts, depots: new Set() }; byOs.set(row.os, b); }
    if (ts > b.branchTs) b.branchTs = ts;
    b.depots.add(row.depot_id);
  }
  // Per-OS min / max of first_observed_at from history. Manifest_id
  // changes are proxies for build changes; MIN across all rows is the
  // per-OS 'we first tracked this OS depot' floor, MAX is the last
  // time a new manifest_id was observed = the last time the OS build
  // shipped.
  type HistBucket = { minFirst: number; maxFirst: number; manifests: number };
  const histByOs = new Map<string, HistBucket>();
  for (const h of history) {
    const ts = Date.parse(h.first_observed_at);
    if (!Number.isFinite(ts)) continue;
    let hb = histByOs.get(h.os);
    if (!hb) { hb = { minFirst: ts, maxFirst: ts, manifests: 0 }; histByOs.set(h.os, hb); }
    if (ts < hb.minFirst) hb.minFirst = ts;
    if (ts > hb.maxFirst) hb.maxFirst = ts;
    hb.manifests++;
  }
  const os: Record<string, {
    first_seen:   string;
    last_updated: string;
    depots:       number;
    manifests:    number;   // # of distinct manifest_ids we have observed for this OS
    source:       "history" | "branch-fallback";
  }> = {};
  for (const [key, b] of byOs.entries()) {
    const hb = histByOs.get(key);
    if (hb) {
      os[key] = {
        first_seen:   new Date(hb.minFirst).toISOString(),
        last_updated: new Date(hb.maxFirst).toISOString(),
        depots:       b.depots.size,
        manifests:    hb.manifests,
        source:       "history",
      };
    } else {
      // No history yet (first observation from Phase 1 runs, or history
      // upsert failed above). Fall back to the branch timestamp -- same
      // value for both cells, same as pre-#226 UX.
      os[key] = {
        first_seen:   new Date(b.branchTs).toISOString(),
        last_updated: new Date(b.branchTs).toISOString(),
        depots:       b.depots.size,
        manifests:    0,
        source:       "branch-fallback",
      };
    }
  }
  const anyHist = [...Object.values(os)].some(v => v.source === "history");
  console.log(`[steam-depot-info] appId=${appId} found=true osCount=${Object.keys(os).length} historyBacked=${anyHist} source=cache`);
  return Response.json(
    { appId, found: true, os },
    { status: 200, headers: { ...corsHeaders, "Cache-Control": "public, max-age=600" } },
  );
});
