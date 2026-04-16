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
    if (!accessToken || !refreshToken) return;

    await _sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    // Clean the tokens out of the URL without a page reload
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // Run on load so the session is set before any onStateChange callbacks fire
  consumeSessionFromHash();

  async function getSession() {
    const { data } = await _sb.auth.getSession();
    return data.session ?? null;
  }

  /**
   * Redirect the user to Steam OpenID. Steam will redirect to the Edge
   * Function, which verifies the assertion and redirects back to the site
   * with session tokens in the hash.
   */
  function loginWithSteam() {
    const params = new URLSearchParams({
      'openid.ns':         'http://specs.openid.net/auth/2.0',
      'openid.mode':       'checkid_setup',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.identity':   'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.return_to':  STEAM_CALLBACK_URL,
      'openid.realm':      STEAM_CALLBACK_URL,
    });
    window.location.href = `${STEAM_OPENID_URL}?${params}`;
  }

  async function logout() {
    await _sb.auth.signOut();
  }

  /**
   * Register a callback fired on every auth state change and immediately
   * on registration with the current state.
   * fn({ session, user })
   */
  function onStateChange(fn) {
    getSession().then(session => fn({ session, user: session?.user ?? null }));
    _sb.auth.onAuthStateChange((_event, session) => {
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

  return { getSession, loginWithSteam, logout, onStateChange, authHeaders };
})();
