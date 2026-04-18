// profile.js — My Account page logic

const SHOW_USERNAME_KEY = 'proton-pulse:show-username-on-reports';

// Filter preferences (used by the View Reports pages)
const HW_GPU_KEY = 'proton-pulse:hw-gpu-vendor';
const HW_OS_KEY  = 'proton-pulse:hw-os';

// Actual hardware spec (auto-fills the web submit-a-report form).
// Keep these prefixed separately so they don't clobber the filter prefs above.
const MYHW_KEYS = {
  cpu:        'proton-pulse:myhw:cpu',
  gpu:        'proton-pulse:myhw:gpu',
  gpuVendor:  'proton-pulse:myhw:gpu-vendor',
  gpuDriver:  'proton-pulse:myhw:gpu-driver',
  ram:        'proton-pulse:myhw:ram',
  vramMb:     'proton-pulse:myhw:vram-mb',
  os:         'proton-pulse:myhw:os',
  osVersion:  'proton-pulse:myhw:os-version',
  kernel:     'proton-pulse:myhw:kernel',
};

function getShowUsername() {
  return localStorage.getItem(SHOW_USERNAME_KEY) === 'true';
}

function setShowUsername(val) {
  localStorage.setItem(SHOW_USERNAME_KEY, val ? 'true' : 'false');
}

// Parse Steam's "System Information" dump (Steam → Help → System Information).
// ProtonDB's browser extension reads the exact same format, so anything a user
// would send to ProtonDB should work here too. Keep this lenient, a partial
// match is still useful (just fills whatever it finds).
//
// See https://help.steampowered.com/ for the panel that produces this text.
function parseSteamSystemInfo(text) {
  const out = {};
  if (!text || typeof text !== 'string') return out;

  // CPU: "CPU Brand: AMD Ryzen 7 5800X3D 8-Core Processor"
  const cpu = text.match(/CPU Brand:\s*(.+)/i);
  if (cpu) out.cpu = cpu[1].trim();

  // OS is the quoted line right under "Operating System Version:"
  // e.g.   "Arch Linux" (64 bit)
  const os = text.match(/Operating System Version:[\s\S]{0,80}?"([^"]+)"/i);
  if (os) {
    // strip "(64 bit)" or build numbers left in the version label
    out.os = os[1].replace(/\s*\(.*?\)\s*/g, '').trim();
  }

  // Kernel name+version as one blob (matches Linux and SteamOS layouts)
  const kVer  = text.match(/Kernel Version:\s*(.+)/i);
  if (kVer) out.kernel = kVer[1].trim();

  // Video card: Steam prints "Driver:  NVIDIA Corporation NVIDIA GeForce RTX 4070"
  // We want just the model string. Drop the leading vendor-corp noise when we can.
  const gpu = text.match(/(?:^|\n)\s*Driver:\s*(.+)/i);
  if (gpu) {
    let g = gpu[1].trim();
    g = g.replace(/^(NVIDIA Corporation|Advanced Micro Devices.*?Inc\.|AMD|Intel Corporation|Intel)\s+/i, '');
    out.gpu = g;
  }

  // GPU driver version line shows up separately
  const gpuDrv = text.match(/Driver Version:\s*(.+)/i);
  if (gpuDrv) out.gpuDriver = gpuDrv[1].trim();

  // VRAM: "VRAM: 12282 Mb"
  const vram = text.match(/VRAM:\s*(\d+)\s*Mb/i);
  if (vram) out.vramMb = Number(vram[1]);

  // RAM shows in megs, e.g. "RAM: 32677 Mb". Convert to whole GB for the form
  const ram = text.match(/RAM:\s*(\d+)\s*Mb/i);
  if (ram) {
    const gb = Math.round(Number(ram[1]) / 1024);
    if (gb > 0) out.ram = `${gb} GB`;
  }

  return out;
}

// Infer the gpu-vendor select value from a free-text GPU string.
// Returns 'nvidia' | 'amd' | 'intel' | ''
//
// This is the one bit I left for you — see the TODO. The tricky case is that
// Linux GPU strings can mention multiple vendors at once (e.g. an NVIDIA card
// on an Intel CPU sometimes shows both "Intel" and "NVIDIA" in the sysinfo).
// Decide which takes priority.
function inferGpuVendor(gpuString) {
  // TODO(you): implement this. ~5-10 lines.
  // Suggested approach:
  //   - lowercase the input once
  //   - check for 'nvidia' / 'geforce' / 'quadro' first (most specific)
  //   - then 'amd' / 'radeon' / 'rdna'
  //   - then 'intel' / 'arc' / 'iris' / 'uhd'
  //   - return '' if nothing matches
  // Feel free to tweak the priority order if you think Intel should win when
  // it's named more explicitly than the others.
  return '';
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
    loadMyHardware();

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

  // Save each My-hardware field as it changes
  for (const [field, el] of Object.entries(myhwInputs)) {
    el?.addEventListener('change', () => saveMyHwField(field, el.value));
  }

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
      el.value = val;
      saveMyHwField(field, val);
      filled++;
    }

    if (filled === 0) flashStatus('Nothing recognized, check the format', false);
    else              flashStatus(`Filled ${filled} field${filled === 1 ? '' : 's'}`, true);
  });

  // Wipe everything in My hardware including the paste area
  myhwClearBtn?.addEventListener('click', () => {
    for (const [field, el] of Object.entries(myhwInputs)) {
      if (!el) continue;
      el.value = '';
      localStorage.removeItem(MYHW_KEYS[field]);
    }
    if (myhwPasteArea) myhwPasteArea.value = '';
    flashStatus('Cleared', true);
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
