/**
 * gh-auth.js — GitHub Device Flow OAuth for Proton Pulse (static site)
 *
 * Setup:
 *   1. Create a GitHub OAuth App at https://github.com/settings/developers
 *      - Enable "Device Flow" in the app settings
 *      - No callback URL is needed for Device Flow
 *      - Requested scope: gist
 *   2. Paste your Client ID into CLIENT_ID below
 *   3. Deploy workers/gh-token-proxy.js to Cloudflare Workers with your
 *      Client Secret set as env var GH_CLIENT_SECRET, then paste the
 *      worker URL into TOKEN_PROXY below.
 */

const GhAuth = (() => {
  // ── Config ────────────────────────────────────────────────────────────────
  const CLIENT_ID   = '';  // TODO: paste GitHub OAuth App Client ID
  const TOKEN_PROXY = '';  // TODO: paste Cloudflare Worker URL (see workers/gh-token-proxy.js)

  const GH_DEVICE_URL = 'https://github.com/login/device/code';
  const GH_USER_URL   = 'https://api.github.com/user';
  const SCOPE         = 'gist';

  const TOKEN_KEY = 'pp_gh_token';
  const USER_KEY  = 'pp_gh_user';

  // ── Internal state ────────────────────────────────────────────────────────
  let _listeners  = [];
  let _pollHandle = null;

  // ── Public getters ────────────────────────────────────────────────────────
  const getToken   = () => localStorage.getItem(TOKEN_KEY);
  const isLoggedIn = () => !!getToken();
  const getUser    = () => {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
  };

  // ── State change listeners ────────────────────────────────────────────────
  /**
   * Register a callback that fires whenever auth state changes.
   * Called immediately with current state on registration.
   * Returns an unsubscribe function.
   */
  function onStateChange(fn) {
    _listeners.push(fn);
    fn({ loggedIn: isLoggedIn(), user: getUser() });
    return () => { _listeners = _listeners.filter(f => f !== fn); };
  }

  function _emit() {
    const state = { loggedIn: isLoggedIn(), user: getUser() };
    _listeners.forEach(fn => fn(state));
  }

  // ── GitHub API helpers ────────────────────────────────────────────────────
  async function _fetchUser(token) {
    const r = await fetch(GH_USER_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
    });
    if (!r.ok) throw new Error(`GitHub user fetch failed: ${r.status}`);
    const u = await r.json();
    // Store only what we need to avoid bloating localStorage
    return { login: u.login, name: u.name, avatar_url: u.avatar_url, html_url: u.html_url };
  }

  // ── Login (Device Flow) ───────────────────────────────────────────────────
  /**
   * Start the GitHub Device Authorization Flow.
   *
   * @param {function} onProgress  Called with progress steps:
   *   { step: 'code', userCode, verificationUri, expiresIn }  — show user code
   *   { step: 'authorized' }                                   — success
   *   { step: 'error', message }                               — failure
   *
   * @returns {Promise<{token, user}>}
   */
  async function login(onProgress) {
    if (!CLIENT_ID)   throw new Error('GitHub OAuth Client ID not configured. Edit CLIENT_ID in gh-auth.js.');
    if (!TOKEN_PROXY) throw new Error('Token proxy not configured. Deploy workers/gh-token-proxy.js and set TOKEN_PROXY in gh-auth.js.');

    // Step 1: Request device + user codes from GitHub
    const dcRes = await fetch(GH_DEVICE_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE })
    });
    if (!dcRes.ok) throw new Error(`Device code request failed: ${dcRes.status}`);
    const dc = await dcRes.json();
    // dc = { device_code, user_code, verification_uri, expires_in, interval }

    onProgress?.({ step: 'code', userCode: dc.user_code, verificationUri: dc.verification_uri, expiresIn: dc.expires_in });

    // Step 2: Poll for token via CORS proxy
    return new Promise((resolve, reject) => {
      let intervalMs = (dc.interval || 5) * 1000;
      const deadline = Date.now() + (dc.expires_in || 900) * 1000;

      const poll = async () => {
        if (Date.now() > deadline) {
          reject(new Error('Authorization timed out. Please try again.'));
          return;
        }

        try {
          const r = await fetch(TOKEN_PROXY, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id:   CLIENT_ID,
              device_code: dc.device_code,
              grant_type:  'urn:ietf:params:oauth:grant-type:device_code'
            })
          });
          if (!r.ok) { _pollHandle = setTimeout(poll, intervalMs); return; }
          const data = await r.json();

          if (data.error === 'authorization_pending') {
            // still waiting — keep polling
          } else if (data.error === 'slow_down') {
            intervalMs += 5000;
          } else if (data.error) {
            reject(new Error(data.error_description || data.error));
            return;
          } else if (data.access_token) {
            localStorage.setItem(TOKEN_KEY, data.access_token);
            try {
              const user = await _fetchUser(data.access_token);
              localStorage.setItem(USER_KEY, JSON.stringify(user));
            } catch (_) { /* non-fatal */ }
            _emit();
            onProgress?.({ step: 'authorized' });
            resolve({ token: data.access_token, user: getUser() });
            return;
          }
        } catch (_) {
          // network hiccup — keep polling
        }

        _pollHandle = setTimeout(poll, intervalMs);
      };

      _pollHandle = setTimeout(poll, intervalMs);
    });
  }

  /** Cancel an in-progress login poll */
  function cancelLogin() {
    if (_pollHandle !== null) { clearTimeout(_pollHandle); _pollHandle = null; }
  }

  /** Clear stored credentials and notify listeners */
  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    _emit();
  }

  return { login, logout, cancelLogin, getToken, getUser, isLoggedIn, onStateChange };
})();
