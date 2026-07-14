/**
 * Auto-save + localStorage fallback for js/shared/drafts.js (#285 follow-up).
 *
 * The submit form now debounces and saves after ~2.5s of quiet input. Cloud
 * save is preferred; if it fails (offline, 5xx, RLS reject) we fall back to
 * localStorage so the user does not lose in-progress notes. Load path prefers
 * whichever of the two is newer. These tests lock all three behaviours.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SUPABASE_URL = 'https://test.supabase.co';
const ANON_KEY     = 'test-anon-key';
const SESSION      = { access_token: 'tok', user: { id: 'u-1' } };

function loadSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/^import\s.*$/gm, '')
    .replace(/^export\s+(async\s+)?(function|const|let|var|class)\s/gm, '$1$2 ')
    .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '');
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _dump: () => Object.fromEntries(store),
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function makeCtx({ fetchMock, localStorage } = {}) {
  const ls = localStorage || makeLocalStorage();
  const ctx = vm.createContext({
    fetch: fetchMock || (() => Promise.resolve(jsonResponse(500, ''))),
    SUPABASE_URL,
    SUPABASE_ANON_KEY: ANON_KEY,
    localStorage: ls,
    console,
    Date,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(loadSrc('js/shared/drafts.js'), ctx);
  return { ctx, ls };
}

describe('local draft store', () => {
  test('write + read round-trips the payload; delete clears it', () => {
    const { ctx } = makeCtx();
    const data = { values: { cpu: 'x86-64' }, state: { verdict: 'yes' } };
    expect(ctx.writeLocalDraft('u-1', '730', data)).toBe(true);
    const got = ctx.readLocalDraft('u-1', '730');
    expect(got.form_data).toEqual(data);
    expect(typeof got.updated_at).toBe('string');
    ctx.deleteLocalDraft('u-1', '730');
    expect(ctx.readLocalDraft('u-1', '730')).toBeNull();
  });

  test('key is namespaced by user id so different accounts do not leak', () => {
    const { ctx, ls } = makeCtx();
    ctx.writeLocalDraft('u-alice', '730', { values: { note: 'a' } });
    ctx.writeLocalDraft('u-bob',   '730', { values: { note: 'b' } });
    expect(Object.keys(ls._dump())).toEqual([
      'pp:draft:u-alice:730', 'pp:draft:u-bob:730',
    ]);
    expect(ctx.readLocalDraft('u-alice', '730').form_data.values.note).toBe('a');
    expect(ctx.readLocalDraft('u-bob',   '730').form_data.values.note).toBe('b');
  });
});

describe('saveDraft cloud-first with local fallback', () => {
  test('cloud success clears any stale local copy and reports where=cloud', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(204, ''));
    const { ctx, ls } = makeCtx({ fetchMock });
    // Seed a stale local row so we can prove the cloud success cleared it.
    ctx.writeLocalDraft('u-1', '730', { values: { old: 'yes' } });
    const res = await ctx.saveDraft(SESSION, '730', { values: { new: 'yes' } });
    expect(res.where).toBe('cloud');
    expect(ls._dump()['pp:draft:u-1:730']).toBeUndefined();
  });

  test('savedVia stamps into form_data._meta so the load path can distinguish manual from auto', async () => {
    // The load path reads _meta.saved_via to decide between auto-applying
    // the draft (manual) and showing the Restore prompt (auto). Verify both
    // the cloud POST body and the local storage row carry the marker.
    const capturedBodies = [];
    const fetchMock = jest.fn(async (_url, opts) => {
      if (opts && opts.method === 'POST') capturedBodies.push(JSON.parse(opts.body));
      return jsonResponse(204, '');
    });
    const { ctx } = makeCtx({ fetchMock });
    await ctx.saveDraft(SESSION, '730', { values: { note: 'x' } }, { savedVia: 'manual' });
    expect(capturedBodies[0].form_data._meta.saved_via).toBe('manual');
    // Force a cloud failure so we hit the local fallback path too.
    const fetchFail = jest.fn(async () => jsonResponse(503, ''));
    const { ctx: ctx2, ls } = makeCtx({ fetchMock: fetchFail });
    await ctx2.saveDraft(SESSION, '730', { values: { note: 'x' } }, { savedVia: 'auto' });
    const localRow = JSON.parse(ls._dump()['pp:draft:u-1:730']);
    expect(localRow.form_data._meta.saved_via).toBe('auto');
  });

  test('cloud failure writes local fallback and reports where=local', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(503, 'upstream unhappy'));
    const { ctx, ls } = makeCtx({ fetchMock });
    const res = await ctx.saveDraft(SESSION, '730', { values: { note: 'draft' } });
    expect(res.where).toBe('local');
    expect(res.error).toMatch(/HTTP 503/);
    const local = JSON.parse(ls._dump()['pp:draft:u-1:730']);
    expect(local.form_data.values.note).toBe('draft');
  });

  test('no session -> writes local under an anon key', async () => {
    const fetchMock = jest.fn();
    const { ctx, ls } = makeCtx({ fetchMock });
    const res = await ctx.saveDraft(null, '730', { values: { note: 'signed out' } });
    expect(res.where).toBe('local');
    expect(Object.keys(ls._dump())).toEqual(['pp:draft:anon:730']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('loadBestDraft picks the newer of cloud / local', () => {
  test('returns cloud when only cloud exists', async () => {
    const cloudRow = { form_data: { values: { note: 'from cloud' } }, updated_at: '2026-07-12T00:00:00Z' };
    const fetchMock = jest.fn(async () => jsonResponse(200, [cloudRow]));
    const { ctx } = makeCtx({ fetchMock });
    const got = await ctx.loadBestDraft(SESSION, '730');
    expect(got.source).toBe('cloud');
    expect(got.form_data.values.note).toBe('from cloud');
  });

  test('returns local when only local exists', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(500, ''));
    const { ctx } = makeCtx({ fetchMock });
    ctx.writeLocalDraft('u-1', '730', { values: { note: 'from local' } });
    const got = await ctx.loadBestDraft(SESSION, '730');
    expect(got.source).toBe('local');
    expect(got.form_data.values.note).toBe('from local');
  });

  test('prefers the newer timestamp when both exist', async () => {
    const cloudRow = { form_data: { values: { note: 'cloud-old' } }, updated_at: '2026-07-01T00:00:00Z' };
    const fetchMock = jest.fn(async () => jsonResponse(200, [cloudRow]));
    const { ctx } = makeCtx({ fetchMock });
    // Local row is dated newer than cloud, should win.
    ctx.writeLocalDraft('u-1', '730', { values: { note: 'local-new' } });
    const got = await ctx.loadBestDraft(SESSION, '730');
    expect(got.source).toBe('local');
    expect(got.form_data.values.note).toBe('local-new');
  });

  test('returns null when neither exists', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(200, []));
    const { ctx } = makeCtx({ fetchMock });
    expect(await ctx.loadBestDraft(SESSION, '730')).toBeNull();
  });
});

describe('alsoTestedLinux draft-restore fix', () => {
  // Source-shape pin: draft restore writes alsoHidden.value directly without
  // clicking a button, so wireRunTypeToggle must attach a 'change' listener
  // on the hidden input that repaints the Yes/No button pressed-state and
  // reveals the notes textarea. Without this the buttons render wrong after
  // restore and the notes stay hidden.
  const SUBMIT_SRC = fs.readFileSync(path.join(__dirname, '..', 'js/shared/submit.js'), 'utf8');
  test('syncAlsoLinuxUi helper is defined and reused from the change handler', () => {
    expect(SUBMIT_SRC).toMatch(/const\s+syncAlsoLinuxUi\s*=/);
    expect(SUBMIT_SRC).toMatch(/alsoHidden\.addEventListener\('change'/);
    expect(SUBMIT_SRC).toMatch(/syncAlsoLinuxUi\(alsoHidden\.value\)/);
  });
});

describe('submit-page draft banner + autosave behaviour (#285 follow-up)', () => {
  // Source-shape pins for the two UX rules the user asked for:
  //   1. Restore banner only surfaces when the draft is "meaningful" -- user
  //      answered a compat question, wrote notes, or set a fault answer.
  //      Bare hardware-prefill drafts should NOT trigger it.
  //   2. Autosave gates on event.isTrusted so the prefill's synthetic change
  //      events do not save the prefilled hardware fields as a draft on
  //      first paint.
  const MAIN_SRC   = fs.readFileSync(path.join(__dirname, '..', 'js/submit/main.js'), 'utf8');
  const SUBMIT_SRC = fs.readFileSync(path.join(__dirname, '..', 'js/shared/submit.js'), 'utf8');

  test('primary save button is labelled "Save" (not "Save Draft")', () => {
    expect(SUBMIT_SRC).toMatch(/id="save-draft-btn"[^>]*>Save<\/button>/);
    expect(SUBMIT_SRC).not.toMatch(/id="save-draft-btn"[^>]*>Save Draft<\/button>/);
  });

  test('any existing draft (not gated on "meaningful") surfaces on load', () => {
    // Reverted the isMeaningfulDraft gate: with the isTrusted autosave trigger
    // in place, prefill cannot land a draft on its own, so a stored draft is
    // by definition user work. Editing hardware / runtime version / launch
    // options used to silently discard on refresh because the old gate only
    // looked for compat-question / notes / fault answers (#285 review).
    expect(MAIN_SRC).not.toContain('isMeaningfulDraft');
    expect(MAIN_SRC).toMatch(/if \(draft\?\.form_data\)\s*\{/);
  });

  test('any saved draft (autosave or manual) auto-applies on load with inline Discard', () => {
    // Simplified model (#285 review): autosave is the primary persistence
    // path; the Save button is the explicit trigger + commit-and-close.
    // Both write the draft, both auto-apply on next load, no Restore
    // banner. The inline saveDraftStatus surfaces "Restored your saved
    // draft" with a Discard link.
    expect(MAIN_SRC).toContain('applyDraftSnapshot(formEl, draft.form_data)');
    expect(MAIN_SRC).toContain('Restored your saved draft');
    expect(MAIN_SRC).toContain('draft-discard-inline');
    // Discard action wipes cloud + local and reloads.
    expect(MAIN_SRC).toContain('deleteLocalDraft');
    expect(MAIN_SRC).toMatch(/window\.location\.reload/);
    // The savedVia distinction is no longer surfaced in the UI.
    expect(MAIN_SRC).not.toMatch(/savedVia:\s*'manual'/);
    expect(MAIN_SRC).not.toMatch(/_sessionCommitted/);
  });

  test('autosave trigger drops events with isTrusted === false (skips prefill)', () => {
    expect(MAIN_SRC).toMatch(/if \(!e\.isTrusted\) return;/);
  });

  test('manual Save navigates back to the source page after persisting', () => {
    // Save is the "commit and close" flow: on success we bounce back to
    // returnTo (if the caller passed one) or the game page as a safe
    // default. The 400ms delay lets the toast land first.
    expect(MAIN_SRC).toMatch(/const dest = returnTo \|\| `app\.html#\/app\/\$\{appId\}`/);
    expect(MAIN_SRC).toMatch(/window\.location\.href = dest/);
  });
});

describe('makeAutoSaver debounces and reports status', () => {
  jest.useFakeTimers();

  test('rapid schedule() calls collapse into one save to localStorage (not cloud)', async () => {
    const fetchMock = jest.fn();  // must NOT be called; autosave is local-only
    const { ctx, ls } = makeCtx({ fetchMock });
    const statuses = [];
    const saver = ctx.makeAutoSaver({
      session: SESSION,
      appId: '730',
      snapshot: () => ({ values: { note: 'draft-content' } }),
      delayMs: 2500,
      onStatus: (s) => statuses.push(s),
    });
    saver.schedule();
    saver.schedule();
    saver.schedule();
    expect(ls._dump()['pp:draft:u-1:730']).toBeUndefined();
    await jest.advanceTimersByTimeAsync(2500);
    // Cloud was never touched -- writes went to localStorage.
    expect(fetchMock).not.toHaveBeenCalled();
    const row = JSON.parse(ls._dump()['pp:draft:u-1:730']);
    expect(row.form_data.values.note).toBe('draft-content');
    expect(row.form_data._meta.saved_via).toBe('auto');
    expect(statuses.map((s) => s.state)).toEqual(['saving', 'saved']);
    expect(statuses[1].where).toBe('local');
  });

  test('flushNow bypasses the debounce and still writes local', async () => {
    const fetchMock = jest.fn();
    const { ctx, ls } = makeCtx({ fetchMock });
    const saver = ctx.makeAutoSaver({
      session: SESSION,
      appId: '730',
      snapshot: () => ({ values: { note: 'now' } }),
      delayMs: 999999,
      onStatus: () => {},
    });
    saver.schedule();
    await saver.flushNow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ls._dump()['pp:draft:u-1:730']).toBeDefined();
  });
});
