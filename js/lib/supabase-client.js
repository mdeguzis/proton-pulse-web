/**
 * supabase-client.js — Steam OpenID + Supabase Auth for Proton Pulse
 * Loaded before page scripts. Exposes the global `SupaAuth` object.
 */

const SUPABASE_URL      = 'https://ilsgdshkaocrmibwdezk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';

// Edge Function URL — handles Steam OpenID return and creates a Supabase session
const STEAM_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/steam-callback`;

// Steam OpenID 2.0 endpoint
const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';

const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SupaAuth = (() => {
  function normalizeReturnTo(redirectTo) {
    const fallbackUrl = new URL('index.html', window.location.href);
    if (!redirectTo) return fallbackUrl.toString();

    try {
      const parsed = new URL(redirectTo, window.location.href);
      if (parsed.origin !== window.location.origin) return fallbackUrl.toString();
      return parsed.toString();
    } catch (_) {
      return fallbackUrl.toString();
    }
  }

  function buildLoginPageUrl(redirectTo) {
    const loginUrl = new URL('auth.html', window.location.href);
    loginUrl.searchParams.set('returnTo', normalizeReturnTo(redirectTo || window.location.href));
    return loginUrl.toString();
  }

  /**
   * Consume access_token + refresh_token from the URL hash after the Steam
   * OpenID callback redirects back to the site.
   */
  async function consumeSessionFromHash() {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.get('type') !== 'steam') return;

    const accessToken  = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) {
      console.warn('[SupaAuth] Steam callback hash missing tokens');
      return;
    }

    console.log('[SupaAuth] Consuming Steam session from URL hash');
    const { error } = await _sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) {
      console.error('[SupaAuth] setSession error:', error.message);
    } else {
      console.log('[SupaAuth] Steam session set successfully');
    }

    // Redirect to the page the user was on before login, if stored
    const returnTo = sessionStorage.getItem('pp:returnTo');
    sessionStorage.removeItem('pp:returnTo');
    if (returnTo) {
      try {
        const parsed = new URL(returnTo, window.location.href);
        if (parsed.origin === window.location.origin) {
          window.location.replace(parsed.toString());
          return;
        }
      } catch (_) { /* fall through */ }
    }
    // Clean the tokens out of the URL without a page reload
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // Run on load so the session is set before any onStateChange callbacks fire
  const _sessionReady = consumeSessionFromHash();

  async function getSession() {
    await _sessionReady;
    const { data } = await _sb.auth.getSession();
    return data.session ?? null;
  }

  /**
   * Redirect the user to Steam OpenID. Steam will redirect to the Edge
   * Function, which verifies the assertion and redirects back to the site
   * with session tokens in the hash.
   */
  function loginWithSteam(redirectTo) {
    console.log('[SupaAuth] Redirecting to Steam OpenID');
    const dest = normalizeReturnTo(redirectTo || window.location.href);
    sessionStorage.setItem('pp:returnTo', dest);
    const callbackUrl = new URL(STEAM_CALLBACK_URL);
    callbackUrl.searchParams.set('returnTo', normalizeReturnTo(redirectTo || window.location.href));
    const params = new URLSearchParams({
      'openid.ns':         'http://specs.openid.net/auth/2.0',
      'openid.mode':       'checkid_setup',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.identity':   'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.return_to':  callbackUrl.toString(),
      'openid.realm':      STEAM_CALLBACK_URL,
    });
    window.location.href = `${STEAM_OPENID_URL}?${params}`;
  }

  async function logout() {
    console.log('[SupaAuth] Signing out');
    await _sb.auth.signOut();
  }

  /**
   * Register a callback fired on every auth state change and immediately
   * on registration with the current state.
   * fn({ session, user })
   */
  function onStateChange(fn) {
    _sessionReady.then(() => getSession()).then(session => {
      console.log('[SupaAuth] Initial state — user:', session?.user?.user_metadata?.name ?? session?.user?.email ?? 'none');
      fn({ session, user: session?.user ?? null });
    });
    _sb.auth.onAuthStateChange((event, session) => {
      console.log('[SupaAuth] Auth event:', event, '| user:', session?.user?.user_metadata?.name ?? session?.user?.email ?? 'none');
      fn({ session, user: session?.user ?? null });
    });
  }

  async function authHeaders() {
    const session = await getSession();
    return {
      apikey:        SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session ? session.access_token : SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  async function updateUserMeta(meta) {
    await _sessionReady;
    const { error } = await _sb.auth.updateUser({ data: meta });
    if (error) throw error;
  }

  return { buildLoginPageUrl, getSession, loginWithSteam, logout, onStateChange, authHeaders, updateUserMeta };
})();

// Expose for ES module consumers (import via js/admin/config.js)
window.SUPABASE_URL      = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
window.SupaAuth          = SupaAuth;
