/**
 * Per-user preference sync (#170): localStorage is the zero-flash source;
 * signed-in users additionally sync to a user_preferences row in Supabase.
 */
const {
  readShowAdultLocal, writeShowAdultLocal, setShowAdult, pullShowAdult,
  readOwnerBadgeSizeLocal, writeOwnerBadgeSizeLocal,
  OWNER_BADGE_SIZE_DEFAULT, OWNER_BADGE_SIZE_MIN, OWNER_BADGE_SIZE_MAX,
} = require('../js/lib/user-prefs.js');

let store;
beforeAll(() => {
  store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
});
beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  delete global.window;
  delete global.fetch;
});

function signedInWindow() {
  global.window = {
    SupaAuth: {
      getSession: async () => ({ user: { id: 'u1' }, access_token: 't' }),
      authHeaders: async () => ({ apikey: 'a', Authorization: 'Bearer t' }),
    },
  };
}

describe('local read/write', () => {
  test('defaults to false, round-trips on/off', () => {
    expect(readShowAdultLocal()).toBe(false);
    writeShowAdultLocal(true);
    expect(store['pp:show-adult']).toBe('on');
    expect(readShowAdultLocal()).toBe(true);
    writeShowAdultLocal(false);
    expect(readShowAdultLocal()).toBe(false);
  });
});

describe('setShowAdult', () => {
  test('signed out: writes local only, not synced', async () => {
    const res = await setShowAdult(true);
    expect(store['pp:show-adult']).toBe('on');
    expect(res).toEqual({ synced: false });
  });

  test('signed in: writes local and upserts a merged prefs bag', async () => {
    signedInWindow();
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ prefs: { theme: 'dark' } }] }) // read current
      .mockResolvedValueOnce({ ok: true }); // upsert

    const res = await setShowAdult(true);

    expect(res).toEqual({ synced: true });
    expect(store['pp:show-adult']).toBe('on');
    const [url, opts] = global.fetch.mock.calls[1];
    expect(url).toContain('/rest/v1/user_preferences?on_conflict=user_id');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.user_id).toBe('u1');
    expect(body.prefs).toEqual({ theme: 'dark', 'show-adult': 'on' }); // merge preserved
  });

  test('signed in but server write fails: local still written, synced false', async () => {
    signedInWindow();
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false });
    const res = await setShowAdult(true);
    expect(store['pp:show-adult']).toBe('on');
    expect(res).toEqual({ synced: false });
  });
});

describe('pullShowAdult', () => {
  test('signed out: reads local, no change', async () => {
    writeShowAdultLocal(true);
    const res = await pullShowAdult();
    expect(res).toEqual({ changed: false, value: true });
  });

  test('signed in: writes the server value into local and reports the change', async () => {
    signedInWindow();
    writeShowAdultLocal(false);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, json: async () => [{ prefs: { 'show-adult': 'on' } }],
    });
    const res = await pullShowAdult();
    expect(res).toEqual({ changed: true, value: true });
    expect(store['pp:show-adult']).toBe('on');
  });

  test('signed in but no stored value: leaves local untouched', async () => {
    signedInWindow();
    writeShowAdultLocal(true);
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => [] });
    const res = await pullShowAdult();
    expect(res).toEqual({ changed: false, value: true });
    expect(store['pp:show-adult']).toBe('on');
  });
});

describe('owner badge size (store tag icon size)', () => {
  test('defaults when unset', () => {
    expect(readOwnerBadgeSizeLocal()).toBe(OWNER_BADGE_SIZE_DEFAULT);
  });

  test('round-trips a valid value', () => {
    expect(writeOwnerBadgeSizeLocal(20)).toBe(20);
    expect(store['pp:owner-badge-size']).toBe('20');
    expect(readOwnerBadgeSizeLocal()).toBe(20);
  });

  test('clamps below the minimum', () => {
    expect(writeOwnerBadgeSizeLocal(2)).toBe(OWNER_BADGE_SIZE_MIN);
    expect(readOwnerBadgeSizeLocal()).toBe(OWNER_BADGE_SIZE_MIN);
  });

  test('clamps above the maximum', () => {
    expect(writeOwnerBadgeSizeLocal(999)).toBe(OWNER_BADGE_SIZE_MAX);
    expect(readOwnerBadgeSizeLocal()).toBe(OWNER_BADGE_SIZE_MAX);
  });

  test('rounds and reads back non-integer / garbage values', () => {
    expect(writeOwnerBadgeSizeLocal(16.7)).toBe(17);
    store['pp:owner-badge-size'] = 'not-a-number';
    expect(readOwnerBadgeSizeLocal()).toBe(OWNER_BADGE_SIZE_DEFAULT);
  });
});


// ---------- Generic boolean pref sync (setPrefBool / pullPrefBool) --------
// Coverage for the #266-groundwork generic path the named helpers wrap.
const {
  readPrefBoolLocal, writePrefBoolLocal, setPrefBool, pullPrefBool,
  readShowOwnerBadgesLocal, pullShowOwnerBadges,
} = require('../js/lib/user-prefs.js');

describe('readPrefBoolLocal / writePrefBoolLocal', () => {
  test('round-trips on/off under pp:<key> and honors the default', () => {
    expect(readPrefBoolLocal('some-flag', true)).toBe(true);   // absent -> dflt
    writePrefBoolLocal('some-flag', true);
    expect(readPrefBoolLocal('some-flag', false)).toBe(true);
    writePrefBoolLocal('some-flag', false);
    expect(readPrefBoolLocal('some-flag', true)).toBe(false);
    expect(store['pp:some-flag']).toBe('off');
  });
});

describe('setPrefBool', () => {
  test('signed out: writes local only, reports synced=false', async () => {
    const r = await setPrefBool('show-owner-badges', true);
    expect(r).toEqual({ synced: false });
    expect(store['pp:show-owner-badges']).toBe('on');
  });

  test('signed in: merges into the prefs bag and upserts', async () => {
    signedInWindow();
    const calls = [];
    global.fetch = jest.fn(async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
      if (!opts.method) return { ok: true, json: async () => [{ prefs: { existing: 'on' } }] };
      return { ok: true, json: async () => [] };
    });
    const r = await setPrefBool('show-owner-badges', true);
    expect(r).toEqual({ synced: true });
    const post = calls.find(c => c.method === 'POST');
    const body = JSON.parse(post.body);
    expect(body.prefs).toMatchObject({ existing: 'on', 'show-owner-badges': 'on' });
    expect(post.url).toContain('on_conflict=user_id');
  });

  test('signed in: upsert failure reports synced=false but local sticks', async () => {
    signedInWindow();
    global.fetch = jest.fn(async (url, opts = {}) => {
      if (!opts.method) return { ok: true, json: async () => [] };
      return { ok: false, json: async () => [] };
    });
    const r = await setPrefBool('show-owner-badges', true);
    expect(r).toEqual({ synced: false });
    expect(store['pp:show-owner-badges']).toBe('on');
  });

  test('network throw degrades to synced=false', async () => {
    signedInWindow();
    global.fetch = jest.fn(async () => { throw new Error('offline'); });
    await expect(setPrefBool('x', true)).resolves.toEqual({ synced: false });
  });
});

describe('pullPrefBool', () => {
  test('signed out: local value wins, no change', async () => {
    writePrefBoolLocal('show-owner-badges', true);
    await expect(pullPrefBool('show-owner-badges', false)).resolves.toEqual({ changed: false, value: true });
  });

  test('server value differs from local: local updated, changed=true', async () => {
    signedInWindow();
    writePrefBoolLocal('show-owner-badges', false);
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => [{ prefs: { 'show-owner-badges': 'on' } }] }));
    await expect(pullPrefBool('show-owner-badges', false)).resolves.toEqual({ changed: true, value: true });
    expect(store['pp:show-owner-badges']).toBe('on');
  });

  test('server has no stored value: local value stands', async () => {
    signedInWindow();
    writePrefBoolLocal('show-owner-badges', true);
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => [{ prefs: {} }] }));
    await expect(pullPrefBool('show-owner-badges', false)).resolves.toEqual({ changed: false, value: true });
  });

  test('fetch failure keeps local value', async () => {
    signedInWindow();
    writePrefBoolLocal('show-owner-badges', true);
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => [] }));
    await expect(pullPrefBool('show-owner-badges', false)).resolves.toEqual({ changed: false, value: true });
  });
});

describe('named owner-badge wrappers delegate to the generic path', () => {
  test('readShowOwnerBadgesLocal reads pp:show-owner-badges', () => {
    store['pp:show-owner-badges'] = 'on';
    expect(readShowOwnerBadgesLocal()).toBe(true);
  });

  test('pullShowOwnerBadges signed out returns local', async () => {
    store['pp:show-owner-badges'] = 'off';
    await expect(pullShowOwnerBadges()).resolves.toEqual({ changed: false, value: false });
  });
});
