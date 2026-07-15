// Inline "Library" panel that renders under a Login-with-Steam button on
// sign-in surfaces (profile signed-out state, auth.html, submit.html
// auth-gate). Mirrors ProtonDB's submit-page pattern: sign-in above,
// alternative identifier input below.
//
// Save persists to the same localStorage keys the /lookup page uses, so
// once a visitor saves an identifier here, My Library / My Wishlist nav
// stop prompting for sign-in.
//
// Usage: put an empty div with a stable id on the page, then call
//   mountInlineProfileLookup('my-container-id');
// once the DOM is ready.

import {
  readSavedLookup,
  writeSavedLookup,
  clearSavedLookup,
} from './lookup-storage.js?v=7b8989d7';

const TEMPLATE = `
  <div class="profile-lookup-inline">
    <div class="pli-title">Or explore any Steam library without signing in</div>
    <div class="pli-copy">
      Provide a Steam identifier so <b>My Library</b> and <b>My Wishlist</b>
      load without another sign-in prompt. Saved to this browser only.
    </div>
    <form class="pli-form" novalidate>
      <label class="pli-label" for="pli-input">Steam ID or Profile URL</label>
      <div class="pli-row">
        <input
          class="pli-input"
          id="pli-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="Steam ID or Profile URL"
          required
        >
        <button class="pli-save" type="submit">Save</button>
      </div>
      <ul class="pli-examples">
        <li><b>Examples:</b></li>
        <li><code>https://steamcommunity.com/id/NAME-IN-URL</code></li>
        <li><code>76561198#########</code></li>
      </ul>
      <div class="pli-hint">
        Not sure where to find yours? See Steam's guide to
        <a href="https://help.steampowered.com/en/faqs/view/2816-BE67-5B69-0FEC" target="_blank" rel="noopener">finding your Steam ID</a>.
        Library and wishlist visibility must be set to <b>Public</b> under
        <a href="https://steamcommunity.com/my/edit/settings" target="_blank" rel="noopener">Privacy Settings</a>
        for them to appear.
      </div>
      <div class="pli-status" hidden></div>
      <div class="pli-actions">
        <a class="pli-detail-link" href="lookup.html">View full library breakdown &rarr;</a>
        <button type="button" class="pli-clear" hidden>Clear saved</button>
      </div>
    </form>
  </div>
`;

async function resolveAndPersist(input) {
  // Same edge-fn call the /lookup page makes; we only need it to succeed
  // to store the resolved SteamID64 alongside the raw input.
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
  if (!body.ok) {
    return { ok: false, error: body.error || 'Lookup failed.' };
  }
  writeSavedLookup(input, body.steamId || '');
  return { ok: true, steamId: body.steamId };
}

export function mountInlineProfileLookup(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = TEMPLATE;

  const form = container.querySelector('.pli-form');
  const input = container.querySelector('.pli-input');
  const save = container.querySelector('.pli-save');
  const status = container.querySelector('.pli-status');
  const clear = container.querySelector('.pli-clear');

  function refreshStatus() {
    const saved = readSavedLookup();
    if (saved.input) {
      status.hidden = false;
      status.textContent = `Saved: ${saved.input}. My Library and My Wishlist will use this profile.`;
      status.classList.add('pli-status--ok');
      status.classList.remove('pli-status--error');
      clear.hidden = false;
    } else {
      status.hidden = true;
      status.textContent = '';
      status.classList.remove('pli-status--ok', 'pli-status--error');
      clear.hidden = true;
    }
  }

  // Autofill on mount so returning visitors see what is already saved.
  const saved = readSavedLookup();
  if (saved.input) input.value = saved.input;
  refreshStatus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) {
      status.hidden = false;
      status.textContent = 'Enter a Steam profile URL, vanity name, or 17-digit Steam ID.';
      status.classList.add('pli-status--error');
      status.classList.remove('pli-status--ok');
      return;
    }
    save.disabled = true;
    status.hidden = false;
    status.textContent = 'Saving...';
    status.classList.remove('pli-status--ok', 'pli-status--error');
    try {
      const result = await resolveAndPersist(value);
      if (!result.ok) {
        status.textContent = result.error;
        status.classList.add('pli-status--error');
        return;
      }
      refreshStatus();
    } catch (err) {
      status.textContent = `Network error: ${err instanceof Error ? err.message : String(err)}`;
      status.classList.add('pli-status--error');
    } finally {
      save.disabled = false;
    }
  });

  clear.addEventListener('click', () => {
    clearSavedLookup();
    input.value = '';
    refreshStatus();
  });
}
