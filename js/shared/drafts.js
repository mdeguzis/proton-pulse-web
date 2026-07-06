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
