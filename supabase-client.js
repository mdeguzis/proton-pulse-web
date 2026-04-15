/**
 * supabase-client.js — Supabase Auth (Google OAuth) for Proton Pulse
 * Loaded before app.js. Exposes the global `SupaAuth` object.
 */

const SUPABASE_URL      = 'https://ilsgdshkaocrmibwdezk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';

const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SupaAuth = (() => {
  async function getSession() {
    const { data } = await _sb.auth.getSession();
    return data.session ?? null;
  }

  async function loginWithGoogle() {
    const { error } = await _sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
    if (error) throw error;
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
    // Fire immediately with current state
    getSession().then(session => fn({ session, user: session?.user ?? null }));
    // Then on every future change
    _sb.auth.onAuthStateChange((_event, session) => {
      fn({ session, user: session?.user ?? null });
    });
  }

  /**
   * Returns headers for authenticated Supabase REST calls.
   * Uses the session access_token so RLS policies fire correctly.
   */
  async function authHeaders() {
    const session = await getSession();
    return {
      apikey:        SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session ? session.access_token : SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  return { getSession, loginWithGoogle, logout, onStateChange, authHeaders };
})();
