// Entry module for profile.html (My Account page). Bootstraps the page:
// reads the session, renders the signed-in/out state, and wires every control.
// Migrated from the page's classic profile.js script.
import {
  IS_LOCAL_DEV, MOCK_USER, HW_GPU_KEY, HW_OS_KEY, CONFIG_TYPE_KEY,
  MYHW_KEYS, SUPABASE_URL, SUPABASE_ANON_KEY, SupaAuth,
} from './config.js?v=87cd0f3d';
import {
  getProtonPulseUserIdFromSession, getShowUsername, setShowUsername,
  escapeHtml, formatSystemUpdated, getWebClientIdProfile,
  getPluginLinkCodeFromLocation, getSteamIdFromSession,
} from './utils.js?v=71a515e5';
import {
  deleteAllMyData, fetchAllMyData, checkMyDataExists,
} from './api/configs.js?v=0c5650ed';
import {
  listLinkedPlugins, completePluginLink, removePluginLink,
} from './api/plugin-links.js?v=05003ae3';
import { setShowAdult, pullShowAdult, readShowAdultLocal } from '../lib/user-prefs.js?v=5d9472de';
import { initMyHardware } from './components/my-hardware.js?v=34fd810c';
import { initSystems } from './components/systems.js?v=382fb770';
import { initMyReports } from './components/my-reports.js?v=59f67107';
import { initLibrary } from './components/library.js?v=fedd0b3a';

(async function () {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const signedIn  = document.getElementById('profile-signed-in');
  const signedOut = document.getElementById('profile-signed-out');
  const loginBtn  = document.getElementById('profile-login-btn');
  const signoutBtn = document.getElementById('profile-signout-btn');
  const deleteDataBtn = document.getElementById('profile-delete-data-btn');
  const deleteDataStatus = document.getElementById('profile-delete-data-status');
  const downloadDataBtn = document.getElementById('profile-download-data-btn');
  const checkDataBtn = document.getElementById('profile-check-data-btn');
  const checkDataStatus = document.getElementById('profile-check-data-status');
  const copyBtn   = document.getElementById('copy-uid-btn');
  const usernameToggle = document.getElementById('show-username-toggle');
  const usernameStatus = document.getElementById('show-username-status');
  const adultToggle    = document.getElementById('show-adult-toggle');
  const adultStatus    = document.getElementById('show-adult-status');
  const hwGpuSelect    = document.getElementById('hw-gpu-vendor');
  const hwOsInput      = document.getElementById('hw-os');
  const configTypeSelect = document.getElementById('config-type');
  const pluginLinkCodeInput = document.getElementById('plugin-link-code');
  const pluginLinkSubmitBtn = document.getElementById('plugin-link-submit-btn');
  const pluginLinkStatus = document.getElementById('plugin-link-status');
  const pluginLinkEntry = document.getElementById('plugin-link-entry');
  const pluginLinkEntryBody = document.getElementById('plugin-link-entry-body');
  const pluginLinkJumpBtn = document.getElementById('plugin-link-jump-btn');
  const pluginLinkCopyBtn = document.getElementById('plugin-link-copy-btn');
  const linkedPluginsSection = document.getElementById('linked-plugins-section');
  const linkedPluginsLoading = document.getElementById('linked-plugins-loading');
  const linkedPluginsEmpty = document.getElementById('linked-plugins-empty');
  const linkedPluginsList = document.getElementById('linked-plugins-list');

  // ── Initialise sub-modules ────────────────────────────────────────────────
  const myhwInputs = {
    cpu:        document.getElementById('myhw-cpu'),
    gpu:        document.getElementById('myhw-gpu'),
    gpuVendor:  document.getElementById('myhw-gpu-vendor'),
    gpuDriver:  document.getElementById('myhw-gpu-driver'),
    ram:        document.getElementById('myhw-ram'),
    vramMb:     document.getElementById('myhw-vram-mb'),
    os:         document.getElementById('myhw-os'),
    osVersion:  document.getElementById('myhw-os-version'),
    kernel:     document.getElementById('myhw-kernel'),
  };

  const hw = initMyHardware({
    myhwInputs,
    myhwPasteArea:   document.getElementById('myhw-paste'),
    myhwParseBtn:    document.getElementById('myhw-parse-btn'),
    myhwClearBtn:    document.getElementById('myhw-clear-btn'),
    myhwStatus:      document.getElementById('myhw-parse-status'),
    myhwSourceTitle: document.getElementById('myhw-source-title'),
    myhwSourceBody:  document.getElementById('myhw-source-body'),
    myhwTabButtons:  Array.from(document.querySelectorAll('.profile-tab-btn[data-pane]')),
    myhwTabPanels: {
      systems: document.getElementById('myhw-pane-systems'),
      local:   document.getElementById('myhw-pane-local'),
    },
  });

  initSystems({
    systemsTable:   document.getElementById('systems-table'),
    systemsTbody:   document.getElementById('systems-tbody'),
    systemsEmpty:   document.getElementById('systems-empty'),
    systemsLoading: document.getElementById('systems-loading'),
    systemsStatus:  document.getElementById('systems-status'),
    systemsRefresh: document.getElementById('systems-refresh-btn'),
    addSysBtn:      document.getElementById('add-system-btn'),
  }, hw);

  const library = initLibrary({
    libraryCount:    document.getElementById('library-count'),
    libraryStatus:   document.getElementById('library-status'),
    libraryEmpty:    document.getElementById('library-empty'),
    libraryRefresh:  document.getElementById('library-refresh-btn'),
    libraryTypes:    document.getElementById('library-types'),
    wishlistCount:   document.getElementById('wishlist-count'),
    wishlistStatus:  document.getElementById('wishlist-status'),
    wishlistEmpty:   document.getElementById('wishlist-empty'),
    wishlistRefresh: document.getElementById('wishlist-refresh-btn'),
    wishlistTypes:   document.getElementById('wishlist-types'),
  });

  initMyReports({
    myConfigsTable:   document.getElementById('my-configs-table'),
    myConfigsTbody:   document.getElementById('my-configs-tbody'),
    myConfigsEmpty:   document.getElementById('my-configs-empty'),
    myConfigsLoading: document.getElementById('my-configs-loading'),
    myConfigsStatus:  document.getElementById('my-configs-status'),
    myConfigsRefresh: document.getElementById('my-configs-refresh-btn'),
    myConfigsSearch:  document.getElementById('my-configs-search'),
  });

  // ── Session display helpers ───────────────────────────────────────────────

  async function syncAvatarVisibility(val, session) {
    if (!session?.user) return;
    const uid = session.user.id;
    const meta = session.user.user_metadata || {};
    const displayName = meta.full_name || meta.name || '';
    const avatarUrl = meta.avatar_url || '';
    const steamId = getSteamIdFromSession(session) || '';
    const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
    if (val) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/author_avatars`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ proton_pulse_user_id: uid, steam_id: steamId, display_name: displayName, avatar_url: avatarUrl }),
      });
      console.debug('[profile] author_avatars upserted', { uid, steamId, displayName, ok: res.ok, status: res.status });
    } else {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/author_avatars?proton_pulse_user_id=eq.${uid}`, {
        method: 'DELETE',
        headers,
      });
      console.debug('[profile] author_avatars deleted', { uid, ok: res.ok, status: res.status });
    }
  }

  function showUser(user, session) {
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
      const meta = user.user_metadata ?? {};
      const fromMeta = typeof meta.show_username === 'boolean' ? meta.show_username : null;
      const val = fromMeta !== null ? fromMeta : getShowUsername();
      if (fromMeta !== null) setShowUsername(val);
      usernameToggle.checked = val;
      usernameStatus.textContent = val ? 'Shown on reports' : 'Anonymous';
      if (session) syncAvatarVisibility(val, session).catch(() => {});
    }
    if (adultToggle) {
      // localStorage is the zero-flash source; pull server value async in
      // case another device changed it and update the toggle if it moved.
      const localVal = readShowAdultLocal();
      adultToggle.checked = localVal;
      if (adultStatus) adultStatus.textContent = localVal ? 'Showing adult games' : 'Hidden by default';
      pullShowAdult().then(({ changed, value }) => {
        if (!changed) return;
        adultToggle.checked = value;
        if (adultStatus) adultStatus.textContent = value ? 'Showing adult games' : 'Hidden by default';
      });
    }
    if (hwGpuSelect) hwGpuSelect.value = localStorage.getItem(HW_GPU_KEY) || '';
    if (hwOsInput)   hwOsInput.value   = localStorage.getItem(HW_OS_KEY)  || '';
    if (configTypeSelect) configTypeSelect.value = localStorage.getItem(CONFIG_TYPE_KEY) || '';
    hw.loadMyHardware();
    hw.renderMyHwSource();
    hw.renderMyHwFieldOrigins();

    signedOut.hidden = true;
    signedIn.hidden  = false;

    checkIsAdminProfile(session).then(function (admin) {
      const roleField = document.getElementById('profile-role-field');
      if (roleField) roleField.hidden = !admin;
    });
  }

  async function checkIsAdminProfile(session) {
    if (!session || !session.access_token) return false;
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/admins?select=proton_pulse_user_id&limit=1',
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + session.access_token } }
      );
      if (!res.ok) return false;
      const rows = await res.json();
      return Array.isArray(rows) && rows.length > 0;
    } catch (_) { return false; }
  }

  function showSignedOut() {
    signedIn.hidden  = true;
    signedOut.hidden = false;
  }

  // ── Plugin linking helpers ────────────────────────────────────────────────

  function showPluginLinkStatus(msg, ok) {
    if (!pluginLinkStatus) return;
    pluginLinkStatus.textContent = msg;
    pluginLinkStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => {
      if (pluginLinkStatus.textContent === msg) pluginLinkStatus.textContent = '';
    }, 3000);
  }

  function focusPluginLinkArea() {
    linkedPluginsSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pluginLinkCodeInput?.focus?.();
    pluginLinkCodeInput?.select?.();
  }

  function renderLinkedPlugins(rows) {
    if (!linkedPluginsLoading || !linkedPluginsEmpty || !linkedPluginsList) return;
    linkedPluginsLoading.hidden = true;
    if (!rows || rows.length === 0) {
      linkedPluginsList.hidden = true;
      linkedPluginsEmpty.hidden = false;
      linkedPluginsList.innerHTML = '';
      return;
    }
    linkedPluginsEmpty.hidden = true;
    linkedPluginsList.hidden = false;
    linkedPluginsList.innerHTML = rows.map((row) => {
      const installationId = escapeHtml(String(row.installationId || ''));
      const linkedAt = escapeHtml(formatSystemUpdated(row.linkedAt));
      const lastSeenAt = escapeHtml(formatSystemUpdated(row.lastSeenAt));
      return `
        <div class="profile-prefill-source" style="margin-bottom:10px">
          <div class="profile-prefill-source-title">${installationId}</div>
          <div class="profile-prefill-source-body">
            Linked: ${linkedAt}<br>
            Last seen: ${lastSeenAt}
          </div>
          <div style="margin-top:8px">
            <button type="button" class="profile-clear-btn linked-plugin-remove-btn" data-installation-id="${installationId}">Unlink</button>
          </div>
        </div>`;
    }).join('');
    linkedPluginsList.querySelectorAll('.linked-plugin-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const installationId = btn.getAttribute('data-installation-id');
        if (!installationId) return;
        try {
          const s = await SupaAuth.getSession();
          if (!s?.user) throw new Error('Sign in with Steam first.');
          await removePluginLink(installationId, s);
          showPluginLinkStatus('Plugin unlinked.', true);
          await refreshLinkedPlugins();
        } catch (e) {
          showPluginLinkStatus(e.message || 'Failed to unlink plugin.', false);
        }
      });
    });
  }

  async function refreshLinkedPlugins() {
    if (!linkedPluginsLoading || !linkedPluginsEmpty || !linkedPluginsList) return;
    const s = await SupaAuth.getSession();
    if (!s?.user) {
      linkedPluginsLoading.hidden = true;
      linkedPluginsList.hidden = true;
      linkedPluginsEmpty.hidden = false;
      linkedPluginsEmpty.textContent = 'Sign in with Steam to manage linked plugins.';
      return;
    }
    linkedPluginsLoading.hidden = false;
    linkedPluginsEmpty.hidden = true;
    try {
      const rows = await listLinkedPlugins(s);
      renderLinkedPlugins(rows);
    } catch (e) {
      linkedPluginsLoading.hidden = true;
      linkedPluginsList.hidden = true;
      linkedPluginsEmpty.hidden = false;
      linkedPluginsEmpty.textContent = e.message || 'Failed to load linked plugins.';
    }
  }

  // ── Initial state ──────────────────────────────────────────────────────────
  if (IS_LOCAL_DEV) {
    showUser(MOCK_USER);
  } else {
    const session = await SupaAuth.getSession();
    if (session?.user) {
      showUser(session.user, session);
      void refreshLinkedPlugins();
    } else {
      showSignedOut();
    }

    SupaAuth.onStateChange(({ user, session }) => {
      if (user) {
        showUser(user, session);
        void refreshLinkedPlugins();
        void library.loadCached();
      } else {
        showSignedOut();
      }
    });
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  loginBtn?.addEventListener('click', () => {
    window.location.href = SupaAuth.buildLoginPageUrl(window.location.href);
  });

  signoutBtn?.addEventListener('click', async () => {
    await SupaAuth.logout();
    showSignedOut();
  });

  deleteDataBtn?.addEventListener('click', async () => {
    const confirmed = window.confirm(
      'This will permanently delete all your reports, cloud configs, hardware systems, votes, and display name. This cannot be undone.\n\nAre you sure?'
    );
    if (!confirmed) return;
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    const cid = getWebClientIdProfile();
    if (!protonPulseUserId && !cid) {
      if (deleteDataStatus) { deleteDataStatus.textContent = 'No account data found to delete.'; deleteDataStatus.style.display = ''; }
      return;
    }
    if (deleteDataBtn) deleteDataBtn.disabled = true;
    if (deleteDataStatus) { deleteDataStatus.textContent = 'Deleting...'; deleteDataStatus.style.display = ''; }
    try {
      await deleteAllMyData(protonPulseUserId, cid, s);
      if (deleteDataStatus) deleteDataStatus.textContent = 'All account data deleted. Signing out...';
      await SupaAuth.logout();
      showSignedOut();
    } catch (e) {
      console.error('[profile] deleteAllMyData error', e);
      if (deleteDataStatus) deleteDataStatus.textContent = e.message || 'Delete failed.';
      if (deleteDataBtn) deleteDataBtn.disabled = false;
    }
  });

  downloadDataBtn?.addEventListener('click', async () => {
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    const cid = getWebClientIdProfile();
    if (downloadDataBtn) downloadDataBtn.disabled = true;
    try {
      const data = await fetchAllMyData(protonPulseUserId, cid, s);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `proton-pulse-data-${(protonPulseUserId || cid || 'export').slice(0, 8)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('[profile] fetchAllMyData error', e);
    } finally {
      if (downloadDataBtn) downloadDataBtn.disabled = false;
    }
  });

  checkDataBtn?.addEventListener('click', async () => {
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    const cid = getWebClientIdProfile();
    if (checkDataBtn) checkDataBtn.disabled = true;
    if (checkDataStatus) { checkDataStatus.textContent = 'Checking...'; checkDataStatus.style.display = ''; }
    try {
      const counts = await checkMyDataExists(protonPulseUserId, cid, s);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const lines = Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(', ');
      if (checkDataStatus) {
        checkDataStatus.textContent = total === 0 ? `No data found. (${lines})` : `Data found -- ${lines}`;
        checkDataStatus.style.color = total === 0 ? 'var(--green)' : 'var(--red)';
      }
    } catch (e) {
      if (checkDataStatus) checkDataStatus.textContent = e.message || 'Check failed.';
    } finally {
      if (checkDataBtn) checkDataBtn.disabled = false;
    }
  });

  copyBtn?.addEventListener('click', () => {
    const uid = document.getElementById('profile-uid')?.textContent || '';
    if (!uid) return;
    navigator.clipboard?.writeText(uid).then(() => {
      copyBtn.classList.add('copied');
      const tip = document.createElement('span');
      tip.className = 'copy-tooltip';
      tip.textContent = 'Copied';
      copyBtn.appendChild(tip);
      requestAnimationFrame(() => tip.classList.add('copy-tooltip--show'));
      setTimeout(() => { tip.remove(); copyBtn.classList.remove('copied'); }, 1000);
    }).catch(() => {});
  });

  usernameToggle?.addEventListener('change', () => {
    const val = usernameToggle.checked;
    setShowUsername(val);
    if (usernameStatus) usernameStatus.textContent = val ? 'Shown on reports' : 'Anonymous';
    SupaAuth.updateUserMeta({ show_username: val }).catch((e) => {
      console.warn('[profile] failed to persist show_username to Supabase user_metadata:', e);
    });
    SupaAuth.getSession().then(s => syncAvatarVisibility(val, s)).catch((e) => {
      console.warn('[profile] syncAvatarVisibility failed:', e);
    });
  });

  adultToggle?.addEventListener('change', () => {
    const val = adultToggle.checked;
    if (adultStatus) adultStatus.textContent = val ? 'Showing adult games' : 'Hidden by default';
    // setShowAdult writes localStorage immediately + upserts to Supabase
    // for signed-in users so the pref follows across devices (#170).
    setShowAdult(val).then(({ synced }) => {
      if (adultStatus && !synced) {
        adultStatus.textContent += ' (device only)';
      }
    });
  });

  hwGpuSelect?.addEventListener('change', () => {
    localStorage.setItem(HW_GPU_KEY, hwGpuSelect.value);
  });

  hwOsInput?.addEventListener('change', () => {
    localStorage.setItem(HW_OS_KEY, hwOsInput.value.trim());
  });

  configTypeSelect?.addEventListener('change', () => {
    const value = configTypeSelect.value || '';
    if (value) localStorage.setItem(CONFIG_TYPE_KEY, value);
    else localStorage.removeItem(CONFIG_TYPE_KEY);
  });

  // ── Plugin link wiring ────────────────────────────────────────────────────
  pluginLinkSubmitBtn?.addEventListener('click', async () => {
    const linkCode = (pluginLinkCodeInput?.value || '').trim().toUpperCase();
    if (!linkCode) {
      showPluginLinkStatus('Enter a link code first.', false);
      return;
    }
    try {
      const s = await SupaAuth.getSession();
      if (!s?.user) throw new Error('Sign in with Steam first.');
      await completePluginLink(linkCode, s);
      if (pluginLinkCodeInput) pluginLinkCodeInput.value = '';
      showPluginLinkStatus('Plugin linked to your Proton Pulse account.', true);
      await refreshLinkedPlugins();
    } catch (e) {
      showPluginLinkStatus(e.message || 'Failed to link plugin.', false);
    }
  });

  const linkCodeFromUrl = getPluginLinkCodeFromLocation();
  if (linkCodeFromUrl && pluginLinkCodeInput && !pluginLinkCodeInput.value) {
    pluginLinkCodeInput.value = linkCodeFromUrl.toUpperCase();
    if (pluginLinkEntry) pluginLinkEntry.hidden = false;
    if (pluginLinkEntryBody) {
      pluginLinkEntryBody.innerHTML = `We prefilled the Decky link code <strong>${escapeHtml(linkCodeFromUrl.toUpperCase())}</strong>. Review it below, then press <strong>Link plugin</strong>.`;
    }
    const session = await SupaAuth.getSession();
    if (session?.user) {
      setTimeout(() => { focusPluginLinkArea(); }, 50);
      showPluginLinkStatus('Decky link code loaded. Press "Link plugin" to finish linking.', true);
    }
  }

  pluginLinkJumpBtn?.addEventListener('click', () => {
    focusPluginLinkArea();
  });

  pluginLinkCopyBtn?.addEventListener('click', async () => {
    const code = (pluginLinkCodeInput?.value || '').trim().toUpperCase();
    if (!code) {
      showPluginLinkStatus('No Decky link code is loaded yet.', false);
      return;
    }
    try {
      await navigator.clipboard?.writeText(code);
      showPluginLinkStatus('Link code copied.', true);
    } catch {
      showPluginLinkStatus('Could not copy the link code.', false);
    }
  });

  // Topbar auth chip + mobile nav are now wired in topbar.js (shared across all pages)
})();
