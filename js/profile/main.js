// Entry module for profile.html (My Account page). Bootstraps the page:
// reads the session, renders the signed-in/out state, and wires every control.
// Migrated from the page's classic profile.js script.
import {
  IS_LOCAL_DEV, MOCK_USER, HW_GPU_KEY, HW_OS_KEY, CONFIG_TYPE_KEY,
  MYHW_KEYS, MYHW_ORIGIN_LABELS, SUPABASE_URL, SUPABASE_ANON_KEY, SupaAuth,
} from './config.js';
import {
  getProtonPulseUserIdFromSession, getShowUsername, setShowUsername,
  parseSteamSystemInfo, inferGpuVendor, parseUploadedSystem,
  isGenericSystemLabel, inferSystemLabel, summarizeSystem,
  getMyHwSourceMeta, setMyHwSourceMeta, getMyHwFieldOrigins,
  setMyHwFieldOrigins, setMyHwFieldOrigin, escapeHtml, formatSystemUpdated,
  getWebClientIdProfile, getMyReportBadges, flaggedMessageHtml,
  mergeMyReportRows, getPluginLinkCodeFromLocation,
} from './utils.js';
import { supabaseHeaders } from './api/supabase.js';
import {
  supabaseUserSystemsUrl, listUserSystems, setDefaultSystem,
  clearDefaultSystem, updateSystemLabel, deleteSystem,
} from './api/systems.js';
import {
  fetchMyUserConfigs, fetchMyCloudConfigs, deleteMyReportsEverywhere,
} from './api/configs.js';
import {
  listLinkedPlugins, completePluginLink, removePluginLink,
} from './api/plugin-links.js';
import { showEditCloudConfigModal, showEditReportModal } from './components/edit-modals.js';

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

  // My hardware (spec used to pre-fill the web submit form)
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
  const myhwPasteArea  = document.getElementById('myhw-paste');
  const myhwParseBtn   = document.getElementById('myhw-parse-btn');
  const myhwClearBtn   = document.getElementById('myhw-clear-btn');
  const myhwStatus     = document.getElementById('myhw-parse-status');
  const myhwSourceTitle = document.getElementById('myhw-source-title');
  const myhwSourceBody  = document.getElementById('myhw-source-body');
  const myhwTabButtons = Array.from(document.querySelectorAll('.profile-tab-btn[data-pane]'));
  const myhwTabPanels  = {
    systems: document.getElementById('myhw-pane-systems'),
    local: document.getElementById('myhw-pane-local'),
  };
  let suppressMyHwSourceTracking = false;

  function setMyHardwarePane(name) {
    myhwTabButtons.forEach((btn) => {
      const active = btn.dataset.pane === name;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    for (const [pane, el] of Object.entries(myhwTabPanels)) {
      if (!el) continue;
      const active = pane === name;
      el.classList.toggle('active', active);
      el.hidden = !active;
    }
  }

  function loadMyHardware() {
    for (const [field, el] of Object.entries(myhwInputs)) {
      if (!el) continue;
      el.value = localStorage.getItem(MYHW_KEYS[field]) || '';
    }
  }

  function saveMyHwField(field, rawVal) {
    const val = (rawVal ?? '').toString().trim();
    if (val) localStorage.setItem(MYHW_KEYS[field], val);
    else     localStorage.removeItem(MYHW_KEYS[field]);
  }

  function flashStatus(msg, good) {
    if (!myhwStatus) return;
    myhwStatus.textContent = msg;
    myhwStatus.style.color = good ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { myhwStatus.textContent = ''; }, 2500);
  }

  function renderMyHwSource() {
    if (!myhwSourceTitle || !myhwSourceBody) return;
    const meta = getMyHwSourceMeta();
    const anyLocal = Object.values(MYHW_KEYS).some((k) => localStorage.getItem(k));
    if (!meta) {
      myhwSourceTitle.textContent = anyLocal ? 'Manual browser values' : 'No source selected yet';
      myhwSourceBody.textContent = anyLocal
        ? 'These values were entered directly in this browser and will pre-fill the web submit form.'
        : 'Save values here manually, paste Steam System Information, or set a default uploaded system above.';
      return;
    }
    if (meta.type === 'uploaded-default') {
      myhwSourceTitle.textContent = `Default uploaded system: ${meta.label || 'Uploaded system'}`;
      myhwSourceBody.textContent = 'The Web prefill values below were copied from your default uploaded system and are used to pre-fill the submit-a-report form until you edit them.';
      return;
    }
    if (meta.type === 'customized') {
      myhwSourceTitle.textContent = `Customized browser copy${meta.originLabel ? ` of ${meta.originLabel}` : ''}`;
      myhwSourceBody.textContent = 'These values started from another source, then were edited in this browser. The edited values below now control web form prefill.';
      return;
    }
    if (meta.type === 'steam-paste') {
      myhwSourceTitle.textContent = 'Pasted Steam System Information';
      myhwSourceBody.textContent = 'These values were parsed from the Steam System Information text you pasted here and now pre-fill the web submit form.';
      return;
    }
    myhwSourceTitle.textContent = 'Manual browser values';
    myhwSourceBody.textContent = 'These values were entered directly in this browser and will pre-fill the web submit form.';
  }

  // Map the meta.type we use in source-meta over to the short key used for
  // per-field origin badges. steam-paste and uploaded-default both write all
  // fields at once, so every field written inherits that type.
  function fieldOriginKeyFor(sourceMeta) {
    if (!sourceMeta) return null;
    if (sourceMeta.type === 'uploaded-default') return 'default-system';
    if (sourceMeta.type === 'steam-paste')      return 'steam-paste';
    return null;
  }

  function renderMyHwFieldOrigins() {
    const origins = getMyHwFieldOrigins();
    document.querySelectorAll('[data-myhw-origin]').forEach((el) => {
      const field  = el.dataset.myhwOrigin;
      const origin = origins[field];
      const caption = origin ? MYHW_ORIGIN_LABELS[origin] : '';
      el.textContent = caption || '';
      if (caption) el.setAttribute('data-origin', origin);
      else el.removeAttribute('data-origin');
    });
  }

  function setLocalHardwareFromParsed(parsed, sourceMeta) {
    suppressMyHwSourceTracking = true;
    try {
      const originKey = fieldOriginKeyFor(sourceMeta);
      // Reset ALL origins before writing, so fields that aren't in this parsed
      // batch don't keep a stale "from default system" label
      const nextOrigins = {};
      for (const [field, val] of Object.entries(parsed)) {
        const el = myhwInputs[field];
        if (!el) continue;
        el.value = val;
        saveMyHwField(field, val);
        if (originKey) nextOrigins[field] = originKey;
      }
      setMyHwFieldOrigins(nextOrigins);
      setMyHwSourceMeta(sourceMeta);
      renderMyHwSource();
      renderMyHwFieldOrigins();
    } finally {
      suppressMyHwSourceTracking = false;
    }
  }

  function markLocalHardwareEdited(field) {
    if (suppressMyHwSourceTracking) return;
    if (field) setMyHwFieldOrigin(field, 'manual');
    const prev = getMyHwSourceMeta();
    if (!prev) {
      setMyHwSourceMeta({ type: 'manual' });
    } else if (prev.type === 'uploaded-default' || prev.type === 'steam-paste') {
      setMyHwSourceMeta({
        type: 'customized',
        originType: prev.type,
        originLabel: prev.label || '',
      });
    }
    renderMyHwSource();
    renderMyHwFieldOrigins();
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
      // Use Supabase user_metadata as authoritative source; fall back to localStorage
      // for users who set the preference before this sync was added.
      const meta = user.user_metadata ?? {};
      const fromMeta = typeof meta.show_username === 'boolean' ? meta.show_username : null;
      const val = fromMeta !== null ? fromMeta : getShowUsername();
      if (fromMeta !== null) setShowUsername(val); // keep localStorage in sync
      usernameToggle.checked = val;
      usernameStatus.textContent = val ? 'Shown on reports' : 'Anonymous';
    }
    if (hwGpuSelect) hwGpuSelect.value = localStorage.getItem(HW_GPU_KEY) || '';
    if (hwOsInput)   hwOsInput.value   = localStorage.getItem(HW_OS_KEY)  || '';
    if (configTypeSelect) configTypeSelect.value = localStorage.getItem(CONFIG_TYPE_KEY) || '';
    loadMyHardware();
    renderMyHwSource();
    renderMyHwFieldOrigins();

    signedOut.hidden = true;
    signedIn.hidden  = false;

    // Show Role field if user is an admin.
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
    // skip Supabase on localhost, show mock profile
    showUser(MOCK_USER);
  } else {
    const session = await SupaAuth.getSession();
    if (session?.user) {
      showUser(session.user);
      void refreshLinkedPlugins();
    } else {
      showSignedOut();
    }

    // ── Stay in sync (e.g. sign-out in another tab) ─────────────────────────
    SupaAuth.onStateChange(({ user, session }) => {
      if (user) {
        showUser(user, session);
        void refreshLinkedPlugins();
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
    const val = usernameToggle.checked;
    setShowUsername(val);
    if (usernameStatus) usernameStatus.textContent = val ? 'Shown on reports' : 'Anonymous';
    // persist to Supabase so the preference follows the account across devices
    SupaAuth.updateUserMeta({ show_username: val }).catch((e) => {
      console.warn('[profile] failed to persist show_username to Supabase user_metadata:', e);
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

  // Save each My-hardware field as it changes, and flag it as manually edited
  // so the per-field origin badge flips to "edited"
  for (const [field, el] of Object.entries(myhwInputs)) {
    el?.addEventListener('change', () => {
      saveMyHwField(field, el.value);
      markLocalHardwareEdited(field);
    });
  }
  myhwTabButtons.forEach((btn) => {
    btn.addEventListener('click', () => setMyHardwarePane(btn.dataset.pane));
  });
  setMyHardwarePane('systems');

  // Parse pasted Steam system info and fill the boxes
  myhwParseBtn?.addEventListener('click', () => {
    const text = myhwPasteArea?.value || '';
    if (!text.trim()) { flashStatus('Paste something first', false); return; }

    const parsed = parseSteamSystemInfo(text);
    let filled = 0;

    // Try to infer the vendor when the GPU string parsed out but vendor didn't
    if (parsed.gpu && !parsed.gpuVendor) {
      const v = inferGpuVendor(parsed.gpu);
      if (v) parsed.gpuVendor = v;
    }

    for (const [field, val] of Object.entries(parsed)) {
      const el = myhwInputs[field];
      if (!el) continue;
      filled++;
    }

    if (filled > 0) {
      setLocalHardwareFromParsed(parsed, { type: 'steam-paste' });
    }

    if (filled === 0) flashStatus('Nothing recognized, check the format', false);
    else              flashStatus(`Filled ${filled} field${filled === 1 ? '' : 's'}`, true);
  });

  // Wipe everything in My hardware including the paste area
  myhwClearBtn?.addEventListener('click', () => {
    suppressMyHwSourceTracking = true;
    for (const [field, el] of Object.entries(myhwInputs)) {
      if (!el) continue;
      el.value = '';
      localStorage.removeItem(MYHW_KEYS[field]);
    }
    if (myhwPasteArea) myhwPasteArea.value = '';
    setMyHwSourceMeta(null);
    renderMyHwSource();
    suppressMyHwSourceTracking = false;
    flashStatus('Cleared', true);
  });

  // ── Your systems (server-side) ────────────────────────────────────────────
  // This is Block 1 on the page, the list of systems the plugin has uploaded
  // into Supabase. Users can rename, mark one as default, or delete. Deletes
  // are soft in the sense that the plugin will just re-create the row next
  // time it pushes hardware info.
  const systemsTable   = document.getElementById('systems-table');
  const systemsTbody   = document.getElementById('systems-tbody');
  const systemsEmpty   = document.getElementById('systems-empty');
  const systemsLoading = document.getElementById('systems-loading');
  const systemsStatus  = document.getElementById('systems-status');
  const systemsRefresh = document.getElementById('systems-refresh-btn');

  // Last list of rows we rendered. Used so the default-toggle handler can
  // grab the sysinfo_text off the row it just starred without a re-fetch
  let systemsCache = [];

  function renderSystems(rows) {
    systemsCache = rows || [];
    systemsLoading.hidden = true;
    if (!rows || rows.length === 0) {
      systemsTable.hidden = true;
      systemsEmpty.hidden = false;
      return;
    }
    systemsEmpty.hidden = true;
    systemsTable.hidden = false;

    // Build rows from the cached list. Label is user-editable so it goes
    // through escapeHtml as the value= attribute
    systemsTbody.innerHTML = rows.map(r => {
      const parsed = parseUploadedSystem(r);
      const displayLabel = isGenericSystemLabel(r.label) ? inferSystemLabel(r) : (r.label || 'Uploaded system');
      const summary = summarizeSystem(parsed);
      const detailRows = [
        ['CPU', parsed.cpu],
        ['GPU', parsed.gpu],
        ['GPU vendor', parsed.gpuVendor ? ({ nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[parsed.gpuVendor] || parsed.gpuVendor) : ''],
        ['GPU driver', parsed.gpuDriver],
        ['RAM', parsed.ram],
        ['VRAM', parsed.vramMb ? `${parsed.vramMb} MB` : ''],
        ['OS', [parsed.os, parsed.osVersion].filter(Boolean).join(' ')],
        ['Kernel', parsed.kernel],
      ].filter(([, value]) => value);
      return `
      <tr data-device-id="${escapeHtml(r.device_id)}">
        <td>
          <div class="profile-systems-label-stack">
            <input type="text" class="profile-systems-label-input"
              data-role="label" value="${escapeHtml(displayLabel)}" maxlength="80">
            <div class="profile-systems-summary">${escapeHtml(summary)}</div>
            <button type="button" class="profile-systems-view-btn" data-role="toggle-details" aria-expanded="false">View hardware</button>
          </div>
        </td>
        <td>${escapeHtml(formatSystemUpdated(r.updated_at))}</td>
        <td class="col-default">
          <label class="profile-systems-default-toggle" title="Set as default">
            <input type="checkbox" data-role="default" ${r.is_default ? 'checked' : ''}>
            <span class="profile-systems-default-switch" aria-hidden="true"></span>
            <span class="profile-systems-default-text">Default</span>
          </label>
        </td>
        <td class="col-delete">
          <button type="button" class="profile-systems-trash" data-role="delete" title="Delete">x</button>
        </td>
      </tr>
      <tr class="profile-systems-details-row" data-details-for="${escapeHtml(r.device_id)}" hidden>
        <td colspan="4">
          <div class="profile-systems-details-card">
            <div class="profile-systems-details-grid">
              ${detailRows.map(([label, value]) => `
                <div class="profile-systems-detail-item">
                  <span class="profile-systems-detail-label">${escapeHtml(label)}</span>
                  <span class="profile-systems-detail-value">${escapeHtml(value)}</span>
                </div>`).join('')}
            </div>
            <div class="profile-systems-detail-note">
              ${r.is_default
                ? 'This default uploaded system currently seeds the Web prefill tab and submit form until you edit those values locally.'
                : 'Mark this as default to use it as the starting source for the Web prefill tab and submit form.'}
            </div>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  function showSystemsStatus(msg, ok) {
    if (!systemsStatus) return;
    systemsStatus.textContent = msg;
    systemsStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { systemsStatus.textContent = ''; }, 2500);
  }

  async function refreshSystems() {
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) {
      systemsLoading.hidden = true;
      systemsTable.hidden = true;
      systemsEmpty.hidden = false;
      systemsEmpty.textContent = 'Sign in with Steam to see your uploaded systems.';
      return;
    }
    systemsLoading.hidden = false;
    try {
      let rows = await listUserSystems(protonPulseUserId, s);
      const genericRows = rows.filter((row) => isGenericSystemLabel(row.label));
      if (genericRows.length) {
        await Promise.allSettled(genericRows.map((row) => {
          const nextLabel = inferSystemLabel(row);
          return updateSystemLabel(protonPulseUserId, row.device_id, nextLabel, s);
        }));
        rows = rows.map((row) => isGenericSystemLabel(row.label)
          ? { ...row, label: inferSystemLabel(row) }
          : row);
      }
      renderSystems(rows);
    } catch (e) {
      systemsLoading.hidden = true;
      showSystemsStatus(e.message || 'Failed to load systems', false);
    }
  }

  // Ask the user if they want to copy the default system's parsed sysinfo
  // into the Block 2 inputs. Only fires when they opt in via confirm()
  function askReplaceLocalFrom(row) {
    const parsed = parseSteamSystemInfo(row.sysinfo_text || '');
    if (Object.keys(parsed).length === 0) return;
    const label = isGenericSystemLabel(row.label) ? inferSystemLabel(row) : (row.label || 'this system');
    const ok = window.confirm(`Replace your local pre-fill values with "${label}"?`);
    if (!ok) return;
    if (parsed.gpu && !parsed.gpuVendor) {
      const v = inferGpuVendor(parsed.gpu);
      if (v) parsed.gpuVendor = v;
    }
    setLocalHardwareFromParsed(parsed, {
      type: 'uploaded-default',
      label,
      deviceId: row.device_id,
    });
    flashStatus('Local values updated from default system', true);
  }

  async function handleSystemsClick(ev) {
    const tr  = ev.target.closest('tr[data-device-id]');
    const btn = ev.target.closest('button[data-role]');
    const defToggle = ev.target.closest('input[data-role="default"]');
    if (!tr || (!btn && !defToggle)) return;
    const deviceId = tr.dataset.deviceId;
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) return;

    try {
      if (defToggle) {
        // defToggle.checked is the state AFTER the click. true = user is
        // turning the default ON for this system; false = they flipped OFF
        // the only checked toggle and want no default at all
        if (defToggle.checked) {
          await setDefaultSystem(protonPulseUserId, deviceId, s);
          await refreshSystems();
          const row = systemsCache.find(r => r.device_id === deviceId);
          if (row) askReplaceLocalFrom(row);
          setMyHardwarePane('local');
        } else {
          await clearDefaultSystem(protonPulseUserId, s);
          await refreshSystems();
          flashStatus('Default cleared', true);
        }
        return;
      }
      if (btn.dataset.role === 'toggle-details') {
        const detailRow = Array.from(systemsTbody?.querySelectorAll('tr[data-details-for]') || [])
          .find((row) => row.getAttribute('data-details-for') === deviceId);
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        btn.textContent = expanded ? 'View hardware' : 'Hide hardware';
        if (detailRow) detailRow.hidden = expanded;
        return;
      }
      if (btn.dataset.role === 'delete') {
        if (!window.confirm('Delete this system? The plugin will re-create it next time you upload.')) return;
        await deleteSystem(protonPulseUserId, deviceId, s);
        await refreshSystems();
      }
    } catch (e) {
      showSystemsStatus(e.message || 'Action failed', false);
    }
  }

  // Label saves on blur. Using focusout so it bubbles through the table
  async function handleSystemsLabelBlur(ev) {
    const input = ev.target.closest('input[data-role="label"]');
    if (!input) return;
    const tr = input.closest('tr[data-device-id]');
    const deviceId = tr?.dataset.deviceId;
    if (!deviceId) return;
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) return;
    try {
      const currentRow = systemsCache.find((row) => row.device_id === deviceId);
      const nextLabel = input.value.trim() || inferSystemLabel(currentRow || {});
      input.value = nextLabel;
      await updateSystemLabel(protonPulseUserId, deviceId, nextLabel, s);
      showSystemsStatus('Saved', true);
    } catch (e) {
      showSystemsStatus(e.message || 'Save failed', false);
    }
  }

  systemsTable?.addEventListener('click', handleSystemsClick);
  systemsTable?.addEventListener('focusout', handleSystemsLabelBlur);
  systemsRefresh?.addEventListener('click', () => { void refreshSystems(); });

  // manual system add form
  const addSysBtn = document.getElementById('add-system-btn');
  const addSysForm = document.getElementById('add-system-form');
  const addSysSubmit = document.getElementById('add-sys-submit');
  const addSysCancel = document.getElementById('add-sys-cancel');
  const addSysStatus = document.getElementById('add-sys-status');
  if (addSysBtn && addSysForm) {
    addSysBtn.addEventListener('click', () => {
      addSysForm.hidden = !addSysForm.hidden;
      addSysBtn.textContent = addSysForm.hidden ? '+ Add system' : '- Cancel';
    });
  }

  if (addSysCancel && addSysForm && addSysBtn) {
    addSysCancel.addEventListener('click', () => {
      addSysForm.hidden = true;
      addSysBtn.textContent = '+ Add system';
    });
  }

  addSysSubmit?.addEventListener('click', async () => {
    const label = document.getElementById('add-sys-label')?.value?.trim() || 'Manual system';
    const cpu = document.getElementById('add-sys-cpu')?.value?.trim() || '';
    const gpu = document.getElementById('add-sys-gpu')?.value?.trim() || '';
    const gpuVendor = document.getElementById('add-sys-gpu-vendor')?.value || '';
    const gpuDriver = document.getElementById('add-sys-gpu-driver')?.value?.trim() || '';
    const ram = document.getElementById('add-sys-ram')?.value?.trim() || '';
    const vram = document.getElementById('add-sys-vram')?.value?.trim() || '';
    const os = document.getElementById('add-sys-os')?.value?.trim() || '';
    const kernel = document.getElementById('add-sys-kernel')?.value?.trim() || '';

    if (!cpu && !gpu) {
      if (addSysStatus) { addSysStatus.textContent = 'At least CPU or GPU is needed'; addSysStatus.style.color = 'var(--red)'; }
      return;
    }

    // build a sysinfo_text blob that parseSteamSystemInfo can read back
    const lines = [];
    if (cpu) lines.push(`CPU Brand: ${cpu}`);
    if (gpu) lines.push(`Video Card: ${gpu}`);
    if (gpuDriver) lines.push(`Driver Version: ${gpuDriver}`);
    // convert user-entered GB to the MB format parseSteamSystemInfo expects
    if (ram) {
      const gb = parseInt(ram.replace(/[^0-9]/g, ''), 10);
      lines.push(`RAM: ${gb * 1024} Mb`);
    }
    if (vram) lines.push(`VRAM: ${vram} Mb`);
    if (os) lines.push(`OS Version: ${os}`);
    if (kernel) lines.push(`Kernel Version: ${kernel}`);
    const sysinfoText = lines.join('\n');

    // generate a device_id for web-created systems so they dont collide
    const deviceId = 'web-' + crypto.randomUUID().slice(0, 12);

    try {
      addSysSubmit.disabled = true;
      addSysSubmit.textContent = 'Saving...';
      const s = await SupaAuth.getSession();
      const protonPulseUserId = getProtonPulseUserIdFromSession(s);
      if (!protonPulseUserId) throw new Error('Not signed in');

      const isFirst = systemsCache.length === 0;

      const resp = await fetch(supabaseUserSystemsUrl(), {
        method: 'POST',
        headers: supabaseHeaders(s, { Prefer: 'return=minimal' }),
        body: JSON.stringify({
          proton_pulse_user_id: protonPulseUserId,
          device_id: deviceId,
          label,
          sysinfo_text: sysinfoText,
          is_default: isFirst,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!resp.ok) throw new Error(`Save failed: HTTP ${resp.status}`);

      addSysForm.hidden = true;
      addSysBtn.textContent = '+ Add system';
      // clear the form inputs
      ['add-sys-label','add-sys-cpu','add-sys-gpu','add-sys-gpu-vendor','add-sys-gpu-driver','add-sys-ram','add-sys-vram','add-sys-os','add-sys-kernel']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      showSystemsStatus('System added', true);
      void refreshSystems();
    } catch (e) {
      if (addSysStatus) { addSysStatus.textContent = e.message || 'Failed'; addSysStatus.style.color = 'var(--red)'; }
    } finally {
      addSysSubmit.disabled = false;
      addSysSubmit.textContent = 'Save system';
    }
  });

  // Initial fetch so the table populates on page load
  void refreshSystems();

  // First-load convenience: if the user has nothing in Block 2 locally and
  // they've got a default system uploaded, copy its parsed sysinfo into the
  // inputs. Never clobbers existing local values
  async function autoFillFromDefaultIfEmpty() {
    const anyLocal = Object.values(MYHW_KEYS).some(k => localStorage.getItem(k));
    if (anyLocal) return;
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) return;
    try {
      const rows = await listUserSystems(protonPulseUserId, s);
      const def = rows.find(r => r.is_default);
      if (!def) return;
      const parsed = parseUploadedSystem(def);
      const label = isGenericSystemLabel(def.label) ? inferSystemLabel(def) : (def.label || 'your system');
      setLocalHardwareFromParsed(parsed, {
        type: 'uploaded-default',
        label,
        deviceId: def.device_id,
      });
      if (Object.keys(parsed).length > 0) {
        flashStatus(`Loaded hardware from "${label}"`, true);
      }
    } catch {
      // non-fatal, just leave Block 2 empty
    }
  }

  void autoFillFromDefaultIfEmpty();

  // ── My reports ────────────────────────────────────────────────────────────
  // Merge publicly published Pulse reports with cloud-synced plugin configs so
  // the profile can show both "published" and "still only in cloud" states.
  const myConfigsTable    = document.getElementById('my-configs-table');
  const myConfigsTbody    = document.getElementById('my-configs-tbody');
  const myConfigsEmpty    = document.getElementById('my-configs-empty');
  const myConfigsLoading  = document.getElementById('my-configs-loading');
  const myConfigsStatus   = document.getElementById('my-configs-status');
  const myConfigsRefresh  = document.getElementById('my-configs-refresh-btn');

  function showMyConfigsStatus(msg, ok) {
    if (!myConfigsStatus) return;
    myConfigsStatus.textContent = msg;
    myConfigsStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { myConfigsStatus.textContent = ''; }, 3000);
  }

  function renderMyConfigs(rows) {
    myConfigsLoading.hidden = true;
    if (!rows || rows.length === 0) {
      myConfigsTable.hidden = true;
      myConfigsEmpty.hidden = false;
      return;
    }
    myConfigsEmpty.hidden = true;
    myConfigsTable.hidden = false;

    myConfigsTbody.innerHTML = rows.map(row => {
      const appLink = `app.html#/app/${encodeURIComponent(row.app_id)}`;
      const reportAnchor = row.published_id ? `${appLink}#report-r${row.published_id}` : null;
      const viewHref = reportAnchor || appLink;
      const name = row.title || `App ${row.app_id}`;
      const badges = getMyReportBadges(row).map((badge) => (
        `<span class="profile-configs-badge profile-configs-badge--${escapeHtml(badge.tone)}">${escapeHtml(badge.label)}</span>`
      )).join('');
      const flaggedNote = row.flagged
        ? `<details class="profile-configs-flagged-details">
            <summary>Why was this flagged?</summary>
            <p>${flaggedMessageHtml(row.flagged_reason)}</p>
          </details>`
        : '';
      const actions = [
        viewHref
          ? `<a class="profile-configs-view-link" href="${escapeHtml(viewHref)}">View</a>`
          : `<span class="profile-configs-view-link profile-configs-view-disabled" title="Not published">View</span>`,
        // Publish on an unpublished cloud row -> open submit.html in
        // "complete from cloud" mode. A config without form responses is
        // effectively an incomplete draft; the user must answer the
        // can-install/start/play/verdict + fault questions before it can
        // be published as a real report. submit.html prefills what we
        // already have (proton version, launch options, hardware) and
        // validation enforces the rest before save
        row.cloud && row.unpublished
          ? `<a class="profile-configs-action profile-configs-publish-btn" href="submit.html?app=${escapeHtml(String(row.app_id))}&fromCloud=1" target="_blank" rel="noopener">Publish</a>`
          : '',
        // Edit: published rows go to submit.html in edit mode (full form
        // pre-fill from user_configs). Cloud-only rows ALSO go to
        // submit.html in "complete from cloud" mode -- there's no real
        // difference between editing a draft and publishing it, both
        // require filling out the report responses
        row.published_id
          ? `<a class="profile-configs-action profile-configs-edit-btn" href="submit.html?app=${escapeHtml(String(row.app_id))}&edit=${escapeHtml(String(row.published_id))}" target="_blank" rel="noopener">Edit</a>`
          : row.cloud
            ? `<a class="profile-configs-action profile-configs-edit-btn" href="submit.html?app=${escapeHtml(String(row.app_id))}&fromCloud=1" target="_blank" rel="noopener">Edit</a>`
            : '',
        `<button type="button" class="profile-configs-action profile-configs-delete-btn" data-app-id="${escapeHtml(String(row.app_id))}">Delete</button>`,
      ].filter(Boolean).join('');
      return `
        <tr data-app-id="${escapeHtml(String(row.app_id))}">
          <td>
            <a href="${escapeHtml(appLink)}" class="profile-configs-game-link">${escapeHtml(name)}</a>
            <div class="profile-configs-appid">App ${escapeHtml(String(row.app_id))}</div>
          </td>
          <td>${escapeHtml(row.rating || '—')}</td>
          <td><div class="profile-configs-status">${badges}</div>${flaggedNote}</td>
          <td>${escapeHtml(formatSystemUpdated(row.updated_at))}</td>
          <td class="col-action"><div class="profile-configs-actions">${actions}</div></td>
        </tr>`;
    }).join('');
  }

  async function refreshMyConfigs() {
    const s = await SupaAuth.getSession();
    if (!s?.user) {
      myConfigsLoading.hidden = true;
      myConfigsTable.hidden   = true;
      myConfigsEmpty.hidden   = false;
      myConfigsEmpty.textContent = 'Sign in with Steam to see your reports and cloud-synced configs.';
      return;
    }
    myConfigsLoading.hidden = false;
    myConfigsEmpty.hidden   = true;
    try {
      const protonPulseUserId = getProtonPulseUserIdFromSession(s);
      const cid  = getWebClientIdProfile();
      const [publishedRows, cloudRows] = await Promise.all([
        fetchMyUserConfigs(protonPulseUserId, cid, s),
        fetchMyCloudConfigs(protonPulseUserId, s),
      ]);
      renderMyConfigs(mergeMyReportRows(publishedRows, cloudRows));
    } catch (e) {
      myConfigsLoading.hidden = true;
      showMyConfigsStatus(e.message || 'Failed to load', false);
    }
  }

  myConfigsRefresh?.addEventListener('click', () => { void refreshMyConfigs(); });
  myConfigsTbody?.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.closest('.profile-configs-publish-btn, .profile-configs-delete-btn, .profile-configs-edit-btn');
    if (!(action instanceof HTMLElement)) return;

    void (async () => {
      const s = await SupaAuth.getSession();
      const protonPulseUserId = getProtonPulseUserIdFromSession(s);
      const cid = getWebClientIdProfile();

      if (action.classList.contains('profile-configs-edit-btn')) {
        const reportId    = action.dataset.reportId;
        const cloudAppId  = action.dataset.cloudAppId;
        if (reportId) {
          void showEditReportModal(reportId, s, async () => {
            showMyConfigsStatus('Report updated', true);
            await refreshMyConfigs();
          });
        } else if (cloudAppId) {
          void showEditCloudConfigModal(protonPulseUserId, cloudAppId, s, async () => {
            showMyConfigsStatus('Config updated', true);
            await refreshMyConfigs();
          });
        }
        return;
      }

      const appId = action.dataset.appId;
      if (!appId) return;

      // Publish + Edit are now <a> links that navigate to submit.html,
      // so the only inline action left is Delete. The browser handles
      // the anchor click without firing this handler for them (no
      // data-app-id on the new anchors either since we matched the
      // selector above already, but the dataset.appId guard above
      // covers it -- only delete-btn carries data-app-id in this
      // updated markup)
      if (!action.classList.contains('profile-configs-delete-btn')) return;
      if (!window.confirm('Delete this report/config from Proton Pulse?')) return;
      action.textContent = 'Deleting...';
      await deleteMyReportsEverywhere(protonPulseUserId, cid, appId, s);
      showMyConfigsStatus('Deleted', true);
      await refreshMyConfigs();
    })().catch((err) => {
      showMyConfigsStatus(err?.message || 'Action failed', false);
      void refreshMyConfigs();
    });
  });

  void refreshMyConfigs();

  // Topbar auth chip + mobile nav are now wired in topbar.js (shared across all pages)
})();
