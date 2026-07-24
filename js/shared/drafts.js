// Cloud draft helpers for the submit form: read/write/delete rows in
// public.user_report_drafts (keyed on user_id + app_id). Backs the "Save Draft"
// button and the restore-on-load prompt on the submit page (#199 follow-up).
//
// Supabase URL + anon key are attached to window by lib/supabase-client.js
// (loaded as a classic script before this module). shared/config.js only
// re-exports SupaAuth, so we read the credentials off window at call time to
// avoid a "does not provide an export named SUPABASE_URL" ES-module error
// that would otherwise blow up the whole submit page.
const _g = typeof window !== 'undefined' ? window : globalThis;
const SB_URL = () => _g.SUPABASE_URL;
const SB_KEY = () => _g.SUPABASE_ANON_KEY;
const REST = () => `${SB_URL()}/rest/v1/user_report_drafts`;

function headers(session, extra) {
  const h = {
    apikey: SB_KEY(),
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
  return Object.assign(h, extra || {});
}

export async function getDraft(session, appId) {
  if (!session?.access_token || !appId) return null;
  const url = `${REST()}?app_id=eq.${encodeURIComponent(String(appId))}&select=form_data,updated_at&limit=1`;
  const r = await fetch(url, { headers: headers(session) });
  if (!r.ok) {
    console.debug('[drafts] getDraft failed', { appId, status: r.status, source: 'user_report_drafts' });
    return null;
  }
  const rows = await r.json();
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  console.debug('[drafts] getDraft', { appId, found: !!row, updated_at: row?.updated_at, source: 'user_report_drafts' });
  return row;
}

export async function upsertDraft(session, appId, formData) {
  if (!session?.access_token || !appId) {
    throw new Error('Sign in with Steam to save a draft.');
  }
  const body = {
    user_id: session.user.id,
    app_id: String(appId),
    form_data: formData || {},
    updated_at: new Date().toISOString(),
  };
  const r = await fetch(`${REST()}?on_conflict=user_id,app_id`, {
    method: 'POST',
    headers: headers(session, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.warn('[drafts] upsertDraft failed', { appId, status: r.status, text, source: 'user_report_drafts' });
    throw new Error(`HTTP ${r.status}`);
  }
  console.debug('[drafts] upsertDraft ok', { appId, fields: Object.keys(formData || {}).length });
}

export async function deleteDraft(session, appId) {
  if (!session?.access_token || !appId) return;
  const url = `${REST()}?app_id=eq.${encodeURIComponent(String(appId))}`;
  const r = await fetch(url, { method: 'DELETE', headers: headers(session) });
  if (!r.ok) {
    console.debug('[drafts] deleteDraft failed', { appId, status: r.status, source: 'user_report_drafts' });
    return;
  }
  console.debug('[drafts] deleteDraft ok', { appId });
}

// ── localStorage fallback ─────────────────────────────────────────────
// Namespaced by user id so switching accounts on the same browser does not
// leak draft contents across identities. Key shape:
//   pp:draft:<userId>:<appId> -> { form_data, updated_at }
// Written when the cloud upsert fails (offline / RLS reject / 5xx) so a user
// mid-report does not lose their notes to a transient network blip.

export function _localDraftKey(userId, appId) {
  return `pp:draft:${userId || 'anon'}:${appId}`;
}

export function readLocalDraft(userId, appId) {
  if (!appId) return null;
  try {
    const raw = localStorage.getItem(_localDraftKey(userId, appId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    console.debug('[drafts] readLocalDraft failed', { appId, error: String(err && err.message || err) });
    return null;
  }
}

export function writeLocalDraft(userId, appId, formData) {
  if (!appId) return false;
  try {
    const payload = { form_data: formData || {}, updated_at: new Date().toISOString() };
    localStorage.setItem(_localDraftKey(userId, appId), JSON.stringify(payload));
    return true;
  } catch (err) {
    // QuotaExceededError, disabled storage (private mode + strict), etc. The
    // draft simply does not persist; caller decides how to surface that.
    console.warn('[drafts] writeLocalDraft failed', { appId, error: String(err && err.message || err) });
    return false;
  }
}

export function deleteLocalDraft(userId, appId) {
  if (!appId) return;
  try { localStorage.removeItem(_localDraftKey(userId, appId)); } catch { /* private mode */ }
}

/**
 * Cloud-first save with localStorage fallback. Returns
 *   { where: 'cloud' | 'local' | null, updated_at, error? }
 * so the caller can surface a "Saved just now" vs "Saved locally (offline)"
 * message to the user. Never throws -- a failing save should show a status,
 * not blow up the auto-save timer.
 *
 * `savedVia` is stamped into form_data._meta so the load path can tell
 * manual saves (user explicitly clicked Save -> auto-apply on next visit)
 * from auto saves (debounced snapshot -> show a Restore prompt so the
 * user opts in). Defaults to 'auto' for makeAutoSaver's convenience.
 */
export async function saveDraft(session, appId, formData, opts = {}) {
  if (!appId) return { where: null, error: 'missing appId' };
  const userId = session?.user?.id;
  const updated_at = new Date().toISOString();
  const savedVia = opts.savedVia === 'manual' ? 'manual' : 'auto';
  const stamped = {
    ...(formData || {}),
    _meta: { ...((formData && formData._meta) || {}), saved_via: savedVia, saved_at: updated_at },
  };
  if (session?.access_token) {
    try {
      await upsertDraft(session, appId, stamped);
      // Cloud won: clear any stale local copy so a later loadBestDraft picks
      // the cloud row unambiguously.
      deleteLocalDraft(userId, appId);
      return { where: 'cloud', updated_at, saved_via: savedVia };
    } catch (err) {
      const wrote = writeLocalDraft(userId, appId, stamped);
      console.warn('[drafts] cloud save failed, wrote local fallback', { appId, cloudError: String(err && err.message || err), localOk: wrote });
      return { where: wrote ? 'local' : null, updated_at: wrote ? updated_at : null, saved_via: savedVia, error: String(err && err.message || err) };
    }
  }
  // Not signed in: local only.
  const wrote = writeLocalDraft(userId, appId, stamped);
  return { where: wrote ? 'local' : null, updated_at: wrote ? updated_at : null, saved_via: savedVia };
}

/**
 * Load whichever of cloud / local is newer. Returns the same shape getDraft
 * did ({ form_data, updated_at }) plus a `source` marker so the UI can label
 * "Restored from cloud" vs "Restored from local backup" if it wants.
 */
export async function loadBestDraft(session, appId) {
  if (!appId) return null;
  const userId = session?.user?.id;
  const local = readLocalDraft(userId, appId);
  let cloud = null;
  if (session?.access_token) {
    try { cloud = await getDraft(session, appId); }
    catch (err) { console.debug('[drafts] loadBestDraft cloud read failed', { appId, error: String(err && err.message || err) }); }
  }
  if (cloud && local) {
    const cloudTs = Date.parse(cloud.updated_at || '') || 0;
    const localTs = Date.parse(local.updated_at || '') || 0;
    return cloudTs >= localTs
      ? { ...cloud, source: 'cloud' }
      : { ...local, source: 'local' };
  }
  if (cloud) return { ...cloud, source: 'cloud' };
  if (local) return { ...local, source: 'local' };
  return null;
}

/**
 * Debounced auto-save factory. Returns a function you call every time the
 * form changes; internally it resets a timer, and only fires saveDraft once
 * the user has been idle for delayMs. Reports state via the onStatus callback
 * so the UI can render Saving... -> Saved just now / Saved locally.
 */
export function makeAutoSaver({ session, appId, snapshot, delayMs = 2500, onStatus }) {
  let timer = null;
  let inFlight = false;
  // Autosave writes to browser localStorage ONLY -- fast, cheap, no network
  // touch on every keypress pause. The manual Save button is where cloud
  // upload happens (see saveDraft above). Load path (loadBestDraft) picks
  // whichever of local / cloud is newer, so an autosave from 30 seconds
  // ago wins over a Save-button upload from 5 minutes ago (#285 review).
  const fire = async () => {
    timer = null;
    if (inFlight) return;
    inFlight = true;
    try {
      onStatus?.({ state: 'saving' });
      const userId = session?.user?.id;
      const data = snapshot();
      const stamped = {
        ...(data || {}),
        _meta: { ...((data && data._meta) || {}), saved_via: 'auto', saved_at: new Date().toISOString() },
      };
      const ok = writeLocalDraft(userId, appId, stamped);
      const now = new Date().toISOString();
      onStatus?.({ state: ok ? 'saved' : 'error', where: ok ? 'local' : null, updated_at: ok ? now : null });
    } finally {
      inFlight = false;
    }
  };
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    },
    async flushNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      await fire();
    },
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

/**
 * Snapshot the current submit form into a plain object suitable for
 * form_data JSONB. Captures every named input/select/textarea value plus the
 * derived _formState so a restored draft feels identical to the state before
 * the user navigated away.
 */
export function snapshotFormData(form) {
  if (!form) return {};
  const values = {};
  for (const field of form.elements || []) {
    const name = field.name;
    if (!name) continue;
    if (field.type === 'radio') {
      if (field.checked) values[name] = field.value;
    } else if (field.type === 'checkbox') {
      if (!Array.isArray(values[name])) values[name] = [];
      if (field.checked) values[name].push(field.value);
    } else {
      values[name] = field.value;
    }
  }
  const state = form._formState || {};
  return {
    values,
    state: {
      canInstall: state.canInstall || null,
      canStart: state.canStart || null,
      canPlay: state.canPlay || null,
      verdict: state.verdict || null,
      requiresFramegen: state.requiresFramegen || null,
      onlineMultiplayer: state.onlineMultiplayer || null,
      localMultiplayer: state.localMultiplayer || null,
      offlineCompat: state.offlineCompat || null,
      faults: state.faults || {},
      tinkeringMethods: Array.from(state.tinkeringMethods || []),
    },
  };
}
