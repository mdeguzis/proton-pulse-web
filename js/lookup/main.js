// Public profile lookup entry (#299).
//
// Form on the left, result on the right. On submit:
//   1. POST the raw input to the public-steam-profile edge function.
//   2. That function resolves vanity + fetches the owned-games list via
//      Steam Web API using our server-side key.
//   3. We map returned appids to the search-index to derive tier counts
//      and render the same "library at a glance" chart shape the home
//      page uses (computeLibraryTierCounts is shared).
//
// ?steamId= or ?input= in the URL skips the form step and runs the
// lookup immediately, so results are shareable and the plugin can
// deep-link into a profile.

import { computeLibraryTierCounts } from '../app/components/home-library-chart.js?v=9b244db9';
import { loadSearchIndex, searchIndex } from '../app/components/search.js?v=7ec2be23';
import { RATING_COLORS, RATING_TEXT } from '../app/config.js?v=f9591262';
import { esc } from '../app/utils.js?v=9a39c726';
// localStorage keys the /lookup page reads + writes are defined in the
// shared module so the inline "Library" panel + the nav fallback + this
// page never drift on the key name.
import { LS_INPUT_KEY, LS_STEAMID_KEY } from '../shared/lookup-storage.js?v=7b8989d7';

const TIER_ORDER = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
const TIER_LABEL = {
  platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked',
};

const els = {
  form:      () => document.getElementById('lookup-form'),
  input:     () => document.getElementById('lookup-input'),
  lookupBtn: () => document.getElementById('lookup-lookup'),
  saveBtn:   () => document.getElementById('lookup-save'),
  error:     () => document.getElementById('lookup-error'),
  loading:   () => document.getElementById('lookup-loading'),
  result:    () => document.getElementById('lookup-result'),
  card:      () => document.getElementById('lookup-profile-card'),
  avatar:    () => document.getElementById('lookup-avatar'),
  persona:   () => document.getElementById('lookup-persona'),
  steamid:   () => document.getElementById('lookup-steamid'),
  steamlink: () => document.getElementById('lookup-steamlink'),
  privateEl: () => document.getElementById('lookup-private'),
  chartMount:    () => document.getElementById('lookup-chart-mount'),
  wishlistMount: () => document.getElementById('lookup-wishlist-mount'),
  savedHint: () => document.getElementById('lookup-saved-hint'),
  clearBtn:  () => document.getElementById('lookup-clear'),
};

function readSaved() {
  try {
    return {
      input: localStorage.getItem(LS_INPUT_KEY) || '',
      steamId: localStorage.getItem(LS_STEAMID_KEY) || '',
    };
  } catch {
    return { input: '', steamId: '' };
  }
}

function writeSaved(input, steamId) {
  try {
    localStorage.setItem(LS_INPUT_KEY, input);
    if (steamId) localStorage.setItem(LS_STEAMID_KEY, steamId);
  } catch {
    // storage disabled (private tab, quota) -- fall back to session-only
  }
}

function clearSaved() {
  try {
    localStorage.removeItem(LS_INPUT_KEY);
    localStorage.removeItem(LS_STEAMID_KEY);
  } catch { /* ignore */ }
}

function updateSavedHint() {
  const hint = els.savedHint();
  if (!hint) return;
  const saved = readSaved();
  hint.hidden = !saved.input;
}

function showError(msg) {
  const e = els.error();
  if (!e) return;
  e.textContent = msg;
  e.hidden = false;
}

function clearError() {
  const e = els.error();
  if (e) { e.hidden = true; e.textContent = ''; }
}

function setLoading(on) {
  const l = els.loading();
  const lk = els.lookupBtn();
  const sv = els.saveBtn();
  if (l) l.hidden = !on;
  if (lk) lk.disabled = !!on;
  if (sv) sv.disabled = !!on;
}

// Render one "at a glance" tier chart for a raw appId set. Uses the exported
// computeLibraryTierCounts helper so the lookup and the signed-in library
// agree by construction. Only the tier view is rendered here; the home
// page's chart chip (Library / Wishlist / Deck / ...) has no meaning for a
// public lookup so it is intentionally omitted.
function renderTierChart(mount, appIds, total, { title, noun }) {
  if (!mount) return;
  if (!appIds || appIds.size === 0) {
    mount.innerHTML = '';
    return;
  }
  const counts = computeLibraryTierCounts(appIds, searchIndex);
  const rated = TIER_ORDER.reduce((sum, t) => sum + (counts[t] || 0), 0);
  const maxBar = Math.max(1, ...TIER_ORDER.map((t) => counts[t] || 0));
  const bars = TIER_ORDER.map((tier) => {
    const n = counts[tier] || 0;
    const pct = Math.round((n / maxBar) * 100);
    const bg = RATING_COLORS[tier] || '#3a4a5a';
    const fg = RATING_TEXT[tier] || '#c8d4e0';
    return `
      <div class="hlc-row">
        <div class="hlc-label" style="color:${fg};background:${bg}">${esc(TIER_LABEL[tier])}</div>
        <div class="hlc-track"><div class="hlc-fill" style="width:${pct}%;background:${bg}"></div></div>
        <div class="hlc-count">${n.toLocaleString()}</div>
      </div>`;
  }).join('');
  const subtitle = `${rated.toLocaleString()} of ${total.toLocaleString()} ${esc(noun)} games have compatibility data.`;
  mount.innerHTML = `
    <div class="home-library-chart">
      <div class="hlc-header">
        <div class="hlc-title">${esc(title)}</div>
      </div>
      <div class="hlc-subtitle">${subtitle}</div>
      <div class="hlc-bars">${bars}</div>
    </div>`;
}

function renderProfileCard(profile, steamId) {
  const avatarEl = els.avatar();
  const personaEl = els.persona();
  const steamidEl = els.steamid();
  const linkEl = els.steamlink();
  if (profile?.avatar) {
    avatarEl.src = profile.avatar;
    avatarEl.hidden = false;
  } else {
    avatarEl.hidden = true;
  }
  personaEl.textContent = profile?.personaName || 'Unnamed profile';
  steamidEl.textContent = `SteamID64: ${steamId}`;
  if (profile?.profileUrl) {
    linkEl.href = profile.profileUrl;
    linkEl.hidden = false;
  } else {
    linkEl.hidden = true;
  }
}

async function fetchLookup(input) {
  const url = `${window.SUPABASE_URL}/functions/v1/public-steam-profile`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: window.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${window.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ input }),
  });
  const body = await res.json().catch(() => ({}));
  return { httpOk: res.ok, ...body };
}

async function runLookup(input, { persist = false } = {}) {
  clearError();
  setLoading(true);
  els.result().hidden = true;
  els.privateEl().hidden = true;

  try {
    // We need the search index for tier counts. Kick it off in parallel with
    // the profile call so users don't wait for a serial round-trip.
    const [payload] = await Promise.all([
      fetchLookup(input),
      loadSearchIndex().catch(() => null),
    ]);
    if (!payload.ok) {
      showError(payload.error || 'Lookup failed. Try again in a moment.');
      return;
    }
    const {
      steamId, profile,
      games = [], gameCount = 0,
      wishlist = [], wishlistCount = 0,
    } = payload;
    renderProfileCard(profile || {}, steamId);
    els.result().hidden = false;

    // Save to localStorage only when the caller asked for persistence
    // (Save button, not the transient Look up button). The saved value
    // survives across visits and lets My Library / My Wishlist nav skip
    // the sign-in prompt (issue #323).
    if (persist) {
      writeSaved(input, steamId);
      updateSavedHint();
    }

    // Persist the resolved steamId in the URL so a reload / share re-runs
    // the same lookup without another form submission.
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('steamId', steamId);
    nextUrl.searchParams.delete('input');
    window.history.replaceState(null, '', nextUrl.toString());

    // Library visibility drives the private-profile notice. Wishlist is a
    // separate Steam privacy toggle, so we treat them independently: a
    // private library still shows the wishlist chart if the wishlist is
    // public, and vice versa.
    if (!profile?.isPublic || gameCount === 0) {
      els.privateEl().hidden = false;
      renderTierChart(els.chartMount(), new Set(), 0, { title: 'Library at a glance', noun: 'owned' });
    } else {
      const appIds = new Set(games.map((g) => Number(g.appid)).filter(Number.isFinite));
      renderTierChart(els.chartMount(), appIds, gameCount, { title: 'Library at a glance', noun: 'owned' });
    }
    if (wishlistCount > 0 && Array.isArray(wishlist)) {
      const wishAppIds = new Set(wishlist.map((w) => Number(w.appid)).filter(Number.isFinite));
      renderTierChart(els.wishlistMount(), wishAppIds, wishlistCount, { title: 'Wishlist at a glance', noun: 'wishlisted' });
    } else {
      const wm = els.wishlistMount();
      if (wm) wm.innerHTML = '';
    }
  } catch (err) {
    console.error('[lookup] runLookup failed', err);
    showError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setLoading(false);
  }
}

// Boot. Priority:
//   1. ?steamId= URL param -- direct-link support wins over browser storage.
//   2. localStorage saved value -- returning visitor sees their library
//      without retyping.
//   3. Empty form for first-time visitors.
(function init() {
  const form = els.form();
  const input = els.input();
  const lookupBtn = els.lookupBtn();
  const saveBtn = els.saveBtn();
  const clearBtn = els.clearBtn();

  function submit({ persist }) {
    const value = input?.value?.trim() || '';
    if (!value) {
      showError('Enter a Steam profile URL, vanity name, or 17-digit Steam ID.');
      return;
    }
    void runLookup(value, { persist });
  }

  // Form submit + Look up button = transient lookup, no storage write.
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit({ persist: false });
    });
  }
  if (lookupBtn) {
    lookupBtn.addEventListener('click', (e) => {
      e.preventDefault();
      submit({ persist: false });
    });
  }
  // Save button = persist to localStorage + run lookup. This is what makes
  // My Library / My Wishlist nav work without a sign-in on later visits.
  if (saveBtn) {
    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      submit({ persist: true });
    });
  }
  // Clear wipes both keys and empties the input. Nav on other pages falls
  // back to the sign-in prompt after this.
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearSaved();
      if (input) input.value = '';
      updateSavedHint();
      els.result().hidden = true;
      els.privateEl().hidden = true;
      const cm = els.chartMount(); if (cm) cm.innerHTML = '';
      const wm = els.wishlistMount(); if (wm) wm.innerHTML = '';
    });
  }

  updateSavedHint();

  // Load-time priority as documented above.
  const params = new URLSearchParams(window.location.search);
  const urlPreset = params.get('steamId') || params.get('input');
  const saved = readSaved();
  const preset = urlPreset || saved.input;
  if (preset) {
    if (input) input.value = preset;
    // If the value came from storage, preserve persistence. If from URL,
    // do not clobber the storage state.
    void runLookup(preset, { persist: !urlPreset && !!saved.input });
  }
})();
