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

import { computeLibraryTierCounts } from '../app/components/home-library-chart.js?v=7ba60b85';
import { loadSearchIndex, searchIndex } from '../app/components/search.js?v=598aaad1';
import { RATING_COLORS, RATING_TEXT } from '../app/config.js?v=f9591262';
import { esc } from '../app/utils.js?v=9a39c726';

const TIER_ORDER = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
const TIER_LABEL = {
  platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked',
};

const els = {
  form:      () => document.getElementById('lookup-form'),
  input:     () => document.getElementById('lookup-input'),
  submit:    () => document.getElementById('lookup-submit'),
  error:     () => document.getElementById('lookup-error'),
  loading:   () => document.getElementById('lookup-loading'),
  result:    () => document.getElementById('lookup-result'),
  card:      () => document.getElementById('lookup-profile-card'),
  avatar:    () => document.getElementById('lookup-avatar'),
  persona:   () => document.getElementById('lookup-persona'),
  steamid:   () => document.getElementById('lookup-steamid'),
  steamlink: () => document.getElementById('lookup-steamlink'),
  privateEl: () => document.getElementById('lookup-private'),
  chartMount:() => document.getElementById('lookup-chart-mount'),
};

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
  const s = els.submit();
  if (l) l.hidden = !on;
  if (s) s.disabled = !!on;
}

// Render the shared "at a glance" tier chart for a raw appId set. Uses the
// exported computeLibraryTierCounts helper from the home page so the math
// stays in one place -- the lookup and the signed-in library agree by
// construction. Only the tier view is rendered here; the home page's chart
// chip (Library / Wishlist / Deck / ...) has no meaning for a public
// lookup so it is intentionally omitted.
function renderTierChart(appIds, total) {
  const mount = els.chartMount();
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
  const subtitle = `${rated.toLocaleString()} of ${total.toLocaleString()} owned games have compatibility data.`;
  mount.innerHTML = `
    <div class="home-library-chart">
      <div class="hlc-header">
        <div class="hlc-title">Library at a glance</div>
      </div>
      <div class="hlc-subtitle">${esc(subtitle)}</div>
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

async function runLookup(input) {
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
    const { steamId, profile, games = [], gameCount = 0 } = payload;
    renderProfileCard(profile || {}, steamId);
    els.result().hidden = false;

    // Persist the resolved steamId in the URL so a reload / share re-runs
    // the same lookup without another form submission.
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('steamId', steamId);
    nextUrl.searchParams.delete('input');
    window.history.replaceState(null, '', nextUrl.toString());

    if (!profile?.isPublic || gameCount === 0) {
      els.privateEl().hidden = false;
      renderTierChart(new Set(), 0);
      return;
    }
    const appIds = new Set(games.map((g) => Number(g.appid)).filter(Number.isFinite));
    renderTierChart(appIds, gameCount);
  } catch (err) {
    console.error('[lookup] runLookup failed', err);
    showError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setLoading(false);
  }
}

// Boot. If the URL already carries a steamId or input, run the lookup
// immediately (skips the form). Otherwise wire the form for the user.
(function init() {
  const form = els.form();
  const input = els.input();
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input?.value?.trim() || '';
      if (!value) {
        showError('Enter a Steam profile URL, vanity name, or 17-digit Steam ID.');
        return;
      }
      void runLookup(value);
    });
  }
  const params = new URLSearchParams(window.location.search);
  const preset = params.get('steamId') || params.get('input');
  if (preset) {
    if (input) input.value = preset;
    void runLookup(preset);
  }
})();
