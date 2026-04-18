// profile.js — My Account page logic

const SHOW_USERNAME_KEY = 'proton-pulse:show-username-on-reports';
const HW_GPU_KEY = 'proton-pulse:hw-gpu-vendor';
const HW_OS_KEY  = 'proton-pulse:hw-os';

function getShowUsername() {
  return localStorage.getItem(SHOW_USERNAME_KEY) === 'true';
}

function setShowUsername(val) {
  localStorage.setItem(SHOW_USERNAME_KEY, val ? 'true' : 'false');
}

(async function () {
  const signedIn  = document.getElementById('profile-signed-in');
  const signedOut = document.getElementById('profile-signed-out');
  const loginBtn  = document.getElementById('profile-login-btn');
  const signoutBtn = document.getElementById('profile-signout-btn');
  const copyBtn   = document.getElementById('copy-uid-btn');
  const copyLabel = document.getElementById('copy-uid-label');
  const usernameToggle = document.getElementById('show-username-toggle');
  const usernameStatus = document.getElementById('show-username-status');
  const hwGpuSelect    = document.getElementById('hw-gpu-vendor');
  const hwOsInput      = document.getElementById('hw-os');

  function showUser(user) {
    const name    = user.user_metadata?.full_name || user.user_metadata?.name || '';
    const email   = user.email || '';
    const uid     = user.id || '';
    const lastAt  = user.last_sign_in_at
      ? new Date(user.last_sign_in_at).toLocaleString()
      : '—';

    document.getElementById('profile-avatar').src              = user.user_metadata?.avatar_url || '';
    document.getElementById('profile-avatar').alt              = name;
    document.getElementById('profile-display-name').textContent = name;
    document.getElementById('profile-user-email').textContent  = email;
    document.getElementById('profile-uid').textContent         = uid;
    document.getElementById('profile-email-detail').textContent = email;
    document.getElementById('profile-last-signin').textContent  = lastAt;
    document.getElementById('profile-steam-username').textContent = name || '—';
    if (usernameToggle) {
      usernameToggle.checked = getShowUsername();
      usernameStatus.textContent = usernameToggle.checked ? 'Shown on reports' : 'Anonymous';
    }
    if (hwGpuSelect) hwGpuSelect.value = localStorage.getItem(HW_GPU_KEY) || '';
    if (hwOsInput)   hwOsInput.value   = localStorage.getItem(HW_OS_KEY)  || '';

    signedOut.hidden = true;
    signedIn.hidden  = false;
  }

  function showSignedOut() {
    signedIn.hidden  = true;
    signedOut.hidden = false;
  }

  // ── Initial state ──────────────────────────────────────────────────────────
  const session = await SupaAuth.getSession();
  if (session?.user) {
    showUser(session.user);
  } else {
    showSignedOut();
  }

  // ── Stay in sync (e.g. sign-out in another tab) ───────────────────────────
  SupaAuth.onStateChange(({ user }) => {
    if (user) { showUser(user); } else { showSignedOut(); }
  });

  // ── Actions ───────────────────────────────────────────────────────────────
  loginBtn?.addEventListener('click', () => {
    window.location.href = SupaAuth.buildLoginPageUrl(window.location.href);
  });

  signoutBtn?.addEventListener('click', async () => {
    await SupaAuth.logout();
    showSignedOut();
  });

  copyBtn?.addEventListener('click', () => {
    const uid = document.getElementById('profile-uid')?.textContent || '';
    if (!uid) return;
    navigator.clipboard?.writeText(uid).then(() => {
      copyBtn.classList.add('copied');
      if (copyLabel) copyLabel.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        if (copyLabel) copyLabel.textContent = 'Copy';
      }, 1500);
    }).catch(() => {});
  });

  usernameToggle?.addEventListener('change', () => {
    setShowUsername(usernameToggle.checked);
    if (usernameStatus) usernameStatus.textContent = usernameToggle.checked ? 'Shown on reports' : 'Anonymous';
  });

  hwGpuSelect?.addEventListener('change', () => {
    localStorage.setItem(HW_GPU_KEY, hwGpuSelect.value);
  });

  hwOsInput?.addEventListener('change', () => {
    localStorage.setItem(HW_OS_KEY, hwOsInput.value.trim());
  });

  // ── Topbar auth chip ──────────────────────────────────────────────────────
  (function() {
    const loginBtn  = document.getElementById('google-login-btn');
    const userMenu  = document.getElementById('google-user-menu');
    const avatarEl  = document.getElementById('google-avatar');
    const nameEl    = document.getElementById('google-username');
    const menuBtn   = document.getElementById('google-menu-btn');
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

  // ── Sidebar toggle ────────────────────────────────────────────────────────
  const toggle  = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  toggle?.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay?.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  });
})();
