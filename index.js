// Sidebar + search
(function() {
  var toggle  = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');

  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  }

  toggle.addEventListener('click', function() {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });

  overlay.addEventListener('click', closeSidebar);

  // close sidebar when a nav link is clicked (mobile)
  sidebar.querySelectorAll('a').forEach(function(a) {
    a.addEventListener('click', closeSidebar);
  });

  // Search: navigate to app.html (avoids CORS issues with Steam storesearch API on GitHub Pages)
  var searchInput = document.getElementById('search');
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      var q = searchInput.value.trim();
      if (!q) return;
      if (/^\d+$/.test(q)) {
        window.location.href = 'app.html#/app/' + q;
      } else {
        window.location.href = 'app.html?q=' + encodeURIComponent(q);
      }
    }
  });
})();

// Pulse report count. Uses HEAD + Content-Range so we don't care whether
// PostgREST returns the aggregate in the body; the header is always there
// when Prefer: count=exact is set. Range: 0-0 keeps the response tiny.
(async function loadPulseStats() {
  const SB = 'https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1';
  const KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';
  try {
    const resp = await fetch(`${SB}/user_configs?select=id`, {
      method: 'HEAD',
      headers: { apikey: KEY, Prefer: 'count=exact', Range: '0-0' },
    });
    // content-range looks like "0-0/1234" or "*/1234"
    const range = resp.headers.get('content-range') || '';
    const total = parseInt(range.split('/')[1], 10);
    const count = Number.isFinite(total) ? total : 0;
    const el = document.getElementById('pulse-report-count');
    if (el) el.textContent = count.toLocaleString();
  } catch (_) {}
})();

// Steam auth chip
(function initSteamAuth() {
  const loginBtn  = document.getElementById('google-login-btn');
  const userMenu  = document.getElementById('google-user-menu');
  const avatarEl  = document.getElementById('google-avatar');
  const nameEl    = document.getElementById('google-username');
  const dropdown  = document.getElementById('google-dropdown');
  const logoutBtn = document.getElementById('google-logout-btn');

  SupaAuth.onStateChange(({ user }) => {
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
    window.location.href = SupaAuth.buildLoginPageUrl(window.location.href);
  });
  logoutBtn?.addEventListener('click', () => { dropdown.classList.remove('open'); SupaAuth.logout(); });
  userMenu?.addEventListener('click', e => {
    if (dropdown.contains(e.target)) return;
    dropdown.classList.toggle('open');
  });

  const chip = document.getElementById('gh-auth-chip');
  document.addEventListener('click', e => {
    if (chip && chip.contains(e.target)) return;
    if (dropdown) dropdown.classList.remove('open');
  });
})();
