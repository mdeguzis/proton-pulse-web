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
