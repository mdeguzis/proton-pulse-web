// profile.js — My Account page logic

(async function () {
  const signedIn  = document.getElementById('profile-signed-in');
  const signedOut = document.getElementById('profile-signed-out');
  const loginBtn  = document.getElementById('profile-login-btn');
  const signoutBtn = document.getElementById('profile-signout-btn');
  const copyBtn   = document.getElementById('copy-uid-btn');
  const copyLabel = document.getElementById('copy-uid-label');

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
  loginBtn?.addEventListener('click', () => SupaAuth.loginWithGoogle());

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
