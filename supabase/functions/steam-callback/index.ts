/**
 * steam-callback — Supabase Edge Function
 *
 * Handles the Steam OpenID 2.0 return URL, verifies the assertion with Steam,
 * fetches the Steam profile, upserts a Supabase user, and redirects back to
 * the site with a valid session.
 *
 * Required env vars (set in Supabase dashboard → Settings → Edge Functions):
 *   STEAM_API_KEY        — Steam Web API key (https://steamcommunity.com/dev/apikey)
 *   SUPABASE_URL         — automatically injected by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — automatically injected by Supabase
 *   SITE_URL             — e.g. https://www.proton-pulse.com
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const STEAM_API_BASE = "https://api.steampowered.com";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const params = url.searchParams;

  const siteUrl = Deno.env.get("SITE_URL") ?? "https://www.proton-pulse.com";
  const siteOrigin = new URL(siteUrl).origin;

  // ── Health check: GET ?health=1 ─────────────────────────────────────────
  if (params.get("health") === "1") {
    return new Response(JSON.stringify({ ok: true, site_url: siteUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── 1. Verify the OpenID assertion with Steam ────────────────────────────
  const verifyParams = new URLSearchParams(params);
  verifyParams.set("openid.mode", "check_authentication");

  const verifyRes = await fetch(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: verifyParams.toString(),
  });
  const verifyText = await verifyRes.text();

  if (!verifyText.includes("is_valid:true")) {
    return new Response("Steam OpenID verification failed", { status: 401 });
  }

  // ── 2. Extract Steam ID from claimed_id ──────────────────────────────────
  // claimed_id looks like: https://steamcommunity.com/openid/id/76561198XXXXXXXXX
  const claimedId = params.get("openid.claimed_id") ?? "";
  const steamIdMatch = claimedId.match(/\/openid\/id\/(\d+)$/);
  if (!steamIdMatch) {
    return new Response("Could not parse Steam ID", { status: 400 });
  }
  const steamId = steamIdMatch[1];

  // ── 3. Fetch Steam profile ───────────────────────────────────────────────
  const steamApiKey = Deno.env.get("STEAM_API_KEY");
  let displayName = `Steam User ${steamId}`;
  let avatarUrl = "";

  if (steamApiKey) {
    try {
      const profileRes = await fetch(
        `${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/?key=${steamApiKey}&steamids=${steamId}`
      );
      const profileJson = await profileRes.json();
      const player = profileJson?.response?.players?.[0];
      if (player) {
        displayName = player.personaname ?? displayName;
        avatarUrl = player.avatarfull ?? player.avatarmedium ?? player.avatar ?? "";
      }
    } catch {
      // non-fatal: fall back to Steam ID as display name
    }
  }

  // ── 4. Upsert Supabase user keyed on Steam ID ────────────────────────────
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Use a deterministic fake email so the same Steam account always maps to
  // the same Supabase user without requiring a real email address.
  const fakeEmail = `steam_${steamId}@steam.protonpulse.local`;
  const password = `steam_${steamId}_${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!.slice(0, 8)}`;

  // Try to sign in first (fast path for returning users)
  const { data: signInData, error: signInError } =
    await supabase.auth.signInWithPassword({ email: fakeEmail, password });

  let session = signInData?.session;

  if (signInError || !session) {
    // New user — create account then sign in
    const { error: createError } = await supabase.auth.admin.createUser({
      email: fakeEmail,
      password,
      email_confirm: true,
      user_metadata: {
        steam_id: steamId,
        full_name: displayName,
        name: displayName,
        avatar_url: avatarUrl,
        provider: "steam",
      },
    });

    if (createError && createError.message !== "User already exists") {
      return new Response(`Failed to create user: ${createError.message}`, { status: 500 });
    }

    // Update metadata for returning users whose profile may have changed
    const { data: listData } = await supabase.auth.admin.listUsers();
    const existing = listData?.users?.find((u) => u.email === fakeEmail);
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        user_metadata: {
          steam_id: steamId,
          full_name: displayName,
          name: displayName,
          avatar_url: avatarUrl,
          provider: "steam",
        },
      });
    }

    const { data: signIn2, error: signIn2Error } =
      await supabase.auth.signInWithPassword({ email: fakeEmail, password });
    if (signIn2Error || !signIn2?.session) {
      return new Response(`Sign-in failed: ${signIn2Error?.message}`, { status: 500 });
    }
    session = signIn2.session;
  }

  // ── 5. Redirect to site with session tokens in the URL fragment ──────────
  // The client-side JS reads these and calls setSession().
  const returnToRaw = params.get("returnTo");
  let redirectUrl = new URL(siteUrl);
  if (returnToRaw) {
    try {
      const parsed = new URL(returnToRaw, siteUrl);
      if (parsed.origin === siteOrigin) {
        redirectUrl = parsed;
      }
    } catch {
      // Fall back to SITE_URL if the provided return target is invalid.
    }
  }
  redirectUrl.hash = `access_token=${session.access_token}&refresh_token=${session.refresh_token}&type=steam`;

  return Response.redirect(redirectUrl.toString(), 302);
});
