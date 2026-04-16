Google OAuth setup guide for Proton Pulse Data (GitHub Pages + Supabase)

# Google OAuth Setup for Proton Pulse Data (GitHub Pages + Supabase)

## Site details

| Key | Value |
|-----|-------|
| Site URL | `https://mdeguzis.github.io/proton-pulse-data/` |
| Supabase project ref | `ilsgdshkaocrmibwdezk` |
| Supabase project name | `decky-proton-pulse` |
| Supabase REST URL | `https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1` |
| Supabase dashboard | `https://supabase.com/dashboard/project/ilsgdshkaocrmibwdezk` |
| Google Cloud project | `decky-proton-pulse` |
| Google Auth Platform | `https://console.cloud.google.com/auth` (select decky-proton-pulse project) |
| Privacy policy URL | `https://mdeguzis.github.io/proton-pulse-data/privacy.html` |
| Terms of service URL | `https://mdeguzis.github.io/proton-pulse-data/terms.html` |

---

## Approach: Supabase Auth (recommended)

The site already uses Supabase for data storage. Supabase Auth supports
Google OAuth out of the box and handles the redirect callback -- no server
needed for a static GitHub Pages site.

---

## Step 1 -- Google Cloud Console

1. Go to https://console.cloud.google.com/
2. Create a project (or reuse an existing one)
3. **APIs & Services -> Credentials -> Create Credentials -> OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Set these **Authorized JavaScript origins**:
   ```
   https://mdeguzis.github.io
   http://localhost
   ```
6. Set these **Authorized redirect URIs**:
   ```
   https://ilsgdshkaocrmibwdezk.supabase.co/auth/v1/callback
   ```
7. Click **Create** -- copy the **Client ID** and **Client Secret**

---

## Step 2 -- Supabase Auth: enable Google provider

1. Open https://supabase.com/dashboard/project/ilsgdshkaocrmibwdezk/auth/providers
2. Find **Google** and toggle it on
3. Paste your **Client ID** and **Client Secret**
4. Under Auth -> URL Configuration set:
   - **Site URL**: `https://mdeguzis.github.io/proton-pulse-data`
   - **Redirect URLs** (add both):
     ```
     https://mdeguzis.github.io/proton-pulse-data/app.html
     https://mdeguzis.github.io/proton-pulse-data/index.html
     ```
5. Save

---

## Step 3 -- Google OAuth Consent Screen (Branding)

The consent screen is what users see when they click "Sign in with Google".
By default it shows the raw Supabase domain (`ilsgdshkaocrmibwdezk.supabase.co`)
which looks sketchy. Branding config fixes most of this.

### Where to configure

Google Cloud Console -> **Google Auth Platform** -> **Branding**
(or APIs & Services -> OAuth consent screen on older UI)

### Settings

| Field | Value |
|-------|-------|
| App name | `Proton Pulse` |
| User support email | `mdeguzis@gmail.com` |
| App logo | Proton Pulse logo (from `decky-proton-pulse/assets/logo.png`) |
| Application home page | `https://mdeguzis.github.io/proton-pulse-data/` |
| Application privacy policy link | `https://mdeguzis.github.io/proton-pulse-data/privacy.html` |
| Application terms of service link | `https://mdeguzis.github.io/proton-pulse-data/terms.html` |
| Developer contact email | `mdeguzis@gmail.com` |

### Authorized domains

All of these need to be listed:

- `github.com`
- `github.io`
- `mdeguzis.github.io`
- `ilsgdshkaocrmibwdezk.supabase.co`

### Known limitation: Supabase domain in consent screen

Google's consent screen header ("Sign in to X") always shows the domain of the
OAuth client's registered origin. Since Supabase sits between the app and Google,
users see "Sign in to ilsgdshkaocrmibwdezk.supabase.co" instead of "Proton Pulse".

This is a known limitation of using any auth intermediary (Supabase, Firebase,
Auth0, etc). Options to improve it:

1. **Verify the app** (free) -- Google shows the app name and logo more
   prominently after verification. The Supabase domain still appears but it
   looks less suspicious with branding around it.
2. **Custom domain on Supabase** (Pro plan, ~$25/mo) -- map something like
   `auth.protonpulse.dev` to the Supabase project so the consent screen
   shows your own domain.
3. **Accept it** -- for an open source project with a small user base, most
   folks who'd use this already understand what Supabase is.

---

## Step 4 -- Google Search Console (domain ownership verification)

Google requires proof that you own the domain used as the app's home page.
This is done through Google Search Console, not the Cloud Console.

### Steps

1. Go to https://search.google.com/search-console/
2. Click **Add property**
3. Choose **URL prefix** and enter `https://mdeguzis.github.io/proton-pulse-data/`
4. Select the **HTML file** verification method
5. Download the verification file (e.g. `googled7b1eda3148e723a.html`)
6. Add it to the repo root and deploy it to gh-pages (add to all deploy steps
   in `update-data.yml`, same pattern as privacy.html/terms.html)
7. Once the file is live at `https://mdeguzis.github.io/proton-pulse-data/googled7b1eda3148e723a.html`,
   go back to Search Console and click **Verify**
8. Don't remove the file after verification -- Google re-checks periodically

### Current verification file

`googled7b1eda3148e723a.html` (added to all four deploy steps in the workflow)

---

## Step 5 -- Google Branding Verification

After Search Console confirms domain ownership, go back to the Google Auth
Platform branding verification.

### Prerequisites

Before submitting:
- Domain ownership verified in Google Search Console (step 4)
- App name, logo, support email filled in (Branding page)
- Application home page set to `https://mdeguzis.github.io/proton-pulse-data/`
  (must be on a domain you own, not github.com)
- Home page must visibly link to the privacy policy (added to site footer)
- Privacy policy and Terms of service URLs must be live and reachable
- Authorized domains configured
- The app only requests non-sensitive scopes (`email`, `profile`, `openid`)

### Common branding verification issues

These came up during our first attempt:

| Issue | Fix |
|-------|-----|
| "Home page URL is not registered to you" | Use your GitHub Pages URL, not the github.com repo URL |
| "Home page does not include a link to privacy policy" | Add privacy/terms links to the site footer |
| "Privacy policy domain is not a valid domain" | The privacy.html page wasn't deployed yet -- deploy first |

### How to submit

1. Go to **Google Auth Platform** -> **Verification Center**
2. If there are previous issues, select "I have fixed the issues" -> Proceed
3. Review the checklist -- all items should be green
4. Click **Submit for verification**

Since Proton Pulse only uses basic sign-in scopes (non-sensitive), Google
usually approves these without requiring a security assessment or letter.
Turnaround is typically a few days to a couple weeks.

### Publishing status

While the app is in **Testing** status:
- Only users explicitly added as test users can sign in
- The consent screen shows an "unverified app" warning
- Branding (app name, logo) may not appear

After verification and switching to **In production**:
- Anyone with a Google account can sign in
- Full branding shows on the consent screen

For non-sensitive scopes, you can also just switch to "In production" from
the **Audience** page without going through verification. The branding should
still show up.

---

## Step 5 -- Add Supabase JS SDK to HTML pages

```html
<!-- before app.js / index.js -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script src="supabase-client.js"></script>
```

---

## Step 6 -- supabase-client.js

```javascript
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

  function onStateChange(fn) {
    // fire immediately with current state
    getSession().then(session => fn({ session, user: session?.user ?? null }));
    // then on every future change
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

  return { getSession, loginWithGoogle, logout, onStateChange, authHeaders };
})();
```

---

## Step 7 -- Login chip HTML (topbar)

The auth chip lives inside a `.gh-auth-chip` wrapper and toggles between
a sign-in button and a user menu with avatar + dropdown.

```html
<div class="gh-auth-chip" id="gh-auth-chip">
  <button class="gh-login-btn" id="google-login-btn" title="Sign in with Google">
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
    <span id="google-login-label">Sign in</span>
  </button>
  <div class="gh-user-menu" id="google-user-menu" hidden>
    <img class="gh-avatar" id="google-avatar" src="" alt="" width="22" height="22">
    <span class="gh-username" id="google-username"></span>
    <button class="gh-chevron" id="google-menu-btn" aria-label="Account menu">&#8964;</button>
    <div class="gh-dropdown" id="google-dropdown">
      <a href="profile.html">Manage account</a>
      <button id="google-logout-btn" class="gh-logout">Sign out</button>
    </div>
  </div>
</div>
```

---

## Step 8 -- Auth chip wiring (index.js / app.js)

```javascript
(function initGoogleAuth() {
  const loginBtn  = document.getElementById('google-login-btn');
  const userMenu  = document.getElementById('google-user-menu');
  const avatarEl  = document.getElementById('google-avatar');
  const nameEl    = document.getElementById('google-username');
  const menuBtn   = document.getElementById('google-menu-btn');
  const dropdown  = document.getElementById('google-dropdown');
  const logoutBtn = document.getElementById('google-logout-btn');

  SupaAuth.onStateChange(({ user }) => {
    console.log('[google-auth] state change, user:', user ? user.email : null);
    if (user) {
      loginBtn.hidden    = true;
      userMenu.hidden    = false;
      avatarEl.src       = user.user_metadata?.avatar_url || '';
      avatarEl.alt       = user.user_metadata?.name || user.email || '';
      nameEl.textContent = user.user_metadata?.name || user.email || '';
    } else {
      loginBtn.hidden = false;
      userMenu.hidden = true;
      if (dropdown) dropdown.classList.remove('open');
    }
  });

  loginBtn?.addEventListener('click', () => {
    console.log('[google-auth] sign-in clicked');
    SupaAuth.loginWithGoogle().catch(err => console.error('[google-auth] login error:', err));
  });
  logoutBtn?.addEventListener('click', () => { dropdown.classList.remove('open'); SupaAuth.logout(); });

  // toggle dropdown on user menu click (but not on dropdown items)
  userMenu?.addEventListener('click', e => {
    if (dropdown.contains(e.target)) return;
    dropdown.classList.toggle('open');
  });

  // close dropdown on outside click
  const chip = document.getElementById('gh-auth-chip');
  document.addEventListener('click', e => {
    if (chip && chip.contains(e.target)) return;
    if (dropdown) dropdown.classList.remove('open');
  });
})();
```

---

## Step 9 -- Using the authed user in API calls

After login `session.user` provides:

```javascript
const session = await SupaAuth.getSession();
const user = session?.user;

user.id                        // Supabase UUID -- use as stable foreign key
user.email                     // Google email
user.user_metadata.name        // Display name
user.user_metadata.avatar_url  // Profile picture URL
```

For RLS-aware Supabase REST calls, use the `authHeaders()` helper:

```javascript
const headers = await SupaAuth.authHeaders();
// headers includes apikey, Authorization (session token), Content-Type
```

---

## Optional -- RLS: tie configs to Google account

Run in the Supabase SQL editor
(https://supabase.com/dashboard/project/ilsgdshkaocrmibwdezk/sql):

```sql
-- Link configs to the authenticated user
ALTER TABLE user_proton_configs
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- Enable Row Level Security
ALTER TABLE user_proton_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own configs"
  ON user_proton_configs FOR ALL
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

---

## Final script load order

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script src="supabase-client.js"></script>
<script src="gh-auth.js"></script>
<script src="gh-gist.js"></script>
<script src="app.js"></script>
```

---

## GitHub Pages deployment

The `update-data.yml` workflow deploys to gh-pages. Site shell files
(HTML, JS, CSS) are pulled from main via `git show main:<file>`.

**Any new static file** (like `privacy.html`, `terms.html`) must be added to
all four deploy steps in the workflow:

1. `finalize` -- uses `git show main:<file> > <file>`
2. `pages-only` -- uses `cp ../repo/<file> ./<file>`
3. `targeted-backfill` -- uses `git show main:<file> > <file>`
4. `coverage-backfill` -- uses `git show main:<file> > <file>`

And the `git add` line in each step needs the filename too. Easy to forget.

To deploy just site file changes without running the full data pipeline,
trigger the workflow with `pages_only: true`.

---

## Troubleshooting

### Sign-in button does nothing (no OAuth popup/redirect)

Check the browser console for JavaScript errors. If the script file has a
syntax error, the entire file fails to parse and no event handlers get wired
up. Common cause: a missing IIFE wrapper `(function() { ... })();` at the
top of index.js or app.js.

The `[google-auth]` console logs help confirm whether the auth code is
running at all:
- `[google-auth] state change, user: null` -- auth code loaded, no session
- `[google-auth] sign-in clicked` -- click handler fired
- `[google-auth] login error: ...` -- OAuth call failed

### Consent screen shows raw Supabase domain

This is expected when using Supabase as the OAuth intermediary. Google shows
the domain that makes the OAuth request, which is Supabase's URL. See
"Known limitation" in Step 3 above.

### Console spam from Google's accountchooser pages

The `unreachable code after return statement` warnings and CSP errors from
`accountchooser:NNNN` and `content.js` are from Google's own OAuth pages
and browser extensions. Not actionable, completely normal.

### New pages not showing up after deploy

If you added a new HTML file and it 404s on the live site, the file probably
isn't in the workflow's deploy steps. See "GitHub Pages deployment" above.

---

## Checklist

- [x] Google Cloud project created (`decky-proton-pulse`)
- [x] OAuth 2.0 Client ID created (Web application type)
- [x] Authorized JavaScript origin: `https://mdeguzis.github.io`
- [x] Authorized redirect URI: `https://ilsgdshkaocrmibwdezk.supabase.co/auth/v1/callback`
- [x] Supabase -> Auth -> Providers -> Google enabled with Client ID + Secret
- [x] Supabase Site URL set to `https://mdeguzis.github.io/proton-pulse-data`
- [x] Redirect URLs added in Supabase Auth settings
- [x] `@supabase/supabase-js` CDN tag added to HTML files
- [x] `supabase-client.js` created and loaded before app.js
- [x] Login chip added to topbar (index.html, app.html)
- [x] Auth state wiring with console logging
- [x] Google OAuth branding configured (app name, logo, links)
- [x] Authorized domains set (github.com, github.io, supabase.co)
- [x] Privacy policy page created (`privacy.html`)
- [x] Terms of service page created (`terms.html`)
- [x] Deploy workflow updated to include privacy.html + terms.html
- [x] Privacy/terms links added to site footer (index.html, app.html, profile.html)
- [x] Application home page changed to GitHub Pages URL (not github.com repo)
- [x] Google Search Console property added for `mdeguzis.github.io/proton-pulse-data/`
- [x] Search Console HTML verification file added (`googled7b1eda3148e723a.html`)
- [x] Verification file added to all four workflow deploy steps
- [ ] Commit, push, and deploy (pages_only) so new files are live
- [ ] Verify domain ownership in Google Search Console
- [ ] Submit branding verification ("I have fixed the issues")
- [ ] Google branding verification approved
- [ ] App publishing status changed to "In production"
