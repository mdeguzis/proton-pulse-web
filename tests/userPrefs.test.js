/**
 * Per-user preference sync (#170): localStorage is the zero-flash source;
 * signed-in users additionally sync to a user_preferences row in Supabase.
 */
const {
  readShowAdultLocal, writeShowAdultLocal, setShowAdult, pullShowAdult,
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
