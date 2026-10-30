// Signed web writes (#62): the browser signs with a non-extractable ECDSA
// key (js/shared/client-key.js) and the client-write edge function checks
// the request (supabase/functions/_shared/clientWrite.js). The round-trip
// tests use Node's real WebCrypto, so a signature the browser module makes
// is verified by the exact code the edge function runs.
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

const ROOT = path.join(__dirname, '..');
const quietConsole = { log() {}, debug() {}, warn() {}, error() {} };
const webGlobals = () => ({
  crypto: globalThis.crypto, TextEncoder, atob, btoa, Uint8Array, JSON, Math, Number, Date, Promise,
  queueMicrotask, console: quietConsole,
});

function loadServer() {
  return loadEsm(['supabase/functions/_shared/clientWrite.js'], webGlobals());
}

// Minimal IndexedDB: one database, object stores as Maps, async requests.
function fakeIndexedDB() {
  const stores = {};
  const request = (fn) => {
    const r = {};
    queueMicrotask(() => {
      try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); }
    });
    return r;
  };
  const db = {
    createObjectStore(name) { stores[name] = new Map(); },
    transaction(name) {
      return {
        objectStore() {
          const m = stores[name];
          return { get: (k) => request(() => m.get(k)), put: (v, k) => request(() => { m.set(k, v); return k; }) };
        },
      };
    },
  };
  return {
    stores,
    open() {
      const r = {};
      queueMicrotask(() => {
        r.result = db;
        if (!stores.keys) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
}

function memoryStorage() {
  const data = {};
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}

function loadClient(fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) {
  const calls = [];
  const ctx = {
    ...webGlobals(),
    indexedDB: fakeIndexedDB(),
    localStorage: memoryStorage(),
    fetch: async (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
  };
  const mod = loadEsm(['js/shared/client-key.js'], ctx);
  return { mod, calls, ctx };
}

const SB_URL = 'https://sb.example/rest/v1';

describe('client-key.js (browser side)', () => {
  test('posts a signed payload to the client-write function with the anon key', async () => {
    const { mod, calls } = loadClient();
    const r = await mod.clientWrite(SB_URL, 'anon-key', 'web-client-1', 'cast_vote', { app_id: '730', report_key: 'k', vote: 1 });
    expect(r).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sb.example/functions/v1/client-write');
    expect(calls[0].opts.headers).toMatchObject({ apikey: 'anon-key', Authorization: 'Bearer anon-key' });
    const body = JSON.parse(calls[0].opts.body);
    expect(JSON.parse(body.payload)).toMatchObject({ action: 'cast_vote', clientId: 'web-client-1', args: { app_id: '730', report_key: 'k', vote: 1 } });
    expect(body.publicKey).toEqual({ kty: 'EC', crv: 'P-256', x: expect.any(String), y: expect.any(String) });
    expect(body.publicKey).not.toHaveProperty('d');
  });

  test('the stored private key is non-extractable and nothing secret lands in localStorage', async () => {
    const { mod, ctx } = loadClient();
    const { privateKey } = await mod.getClientKeyPair();
    expect(privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('jwk', privateKey)).rejects.toThrow();
    await mod.clientWrite(SB_URL, 'k', 'web-client-1', 'cast_vote', { app_id: '1', report_key: 'k', vote: 1 });
    expect(Object.keys(ctx.localStorage.data)).toEqual(['proton-pulse:web-client-last-ts']);
  });

  test('reuses one key pair and sends strictly increasing timestamps', async () => {
    const { mod, calls } = loadClient();
    const a = mod.clientWrite(SB_URL, 'k', 'web-client-1', 'cast_vote', { app_id: '1', report_key: 'a', vote: 1 });
    const b = mod.clientWrite(SB_URL, 'k', 'web-client-1', 'cast_vote', { app_id: '1', report_key: 'b', vote: -1 });
    await Promise.all([a, b]);
    const [p1, p2] = calls.map((c) => JSON.parse(c.opts.body));
    expect(p1.publicKey).toEqual(p2.publicKey);
    expect(JSON.parse(p2.payload).ts).toBeGreaterThan(JSON.parse(p1.payload).ts);
  });

  test('a failed write does not block the next one', async () => {
    let n = 0;
    const { mod } = loadClient(async () => {
      n++;
      if (n === 1) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    await expect(mod.clientWrite(SB_URL, 'k', 'web-client-1', 'cast_vote', { app_id: '1', report_key: 'a', vote: 1 })).rejects.toThrow('offline');
    await expect(mod.clientWrite(SB_URL, 'k', 'web-client-1', 'cast_vote', { app_id: '1', report_key: 'a', vote: 0 })).resolves.toMatchObject({ ok: true });
  });
});

describe('client-write request checks (edge function side)', () => {
  const server = loadServer();
  const NOW = 1_800_000_000_000;
  const sig = 'A'.repeat(86);
  const body = (p, extra = {}) => ({ payload: JSON.stringify(p), signature: sig, ...extra });
  const vote = (over = {}) => ({ action: 'cast_vote', clientId: 'web-client-1', ts: NOW, args: { app_id: '730', report_key: 'k', vote: 1 }, ...over });

  test('accepts a well-formed vote and returns only the checked args', () => {
    const r = server.parseSignedRequest(body(vote({ args: { app_id: '730', report_key: 'k', vote: -1, extra: 'x' } })), NOW);
    expect(r).toMatchObject({ action: 'cast_vote', clientId: 'web-client-1', ts: NOW, publicKey: null });
    expect(r.args).toEqual({ app_id: '730', report_key: 'k', vote: -1 });
  });

  test.each([
    ['unknown action', vote({ action: 'drop_table' })],
    ['bad client id', vote({ clientId: 'x' })],
    ['ts too old', vote({ ts: NOW - 6 * 60 * 1000 })],
    ['ts not an integer', vote({ ts: 'soon' })],
    ['vote out of range', vote({ args: { app_id: '730', report_key: 'k', vote: 5 } })],
    ['non-numeric app id', vote({ args: { app_id: 'gog:1', report_key: 'k', vote: 1 } })],
    ['oversized profile name', vote({ action: 'delete_cloud_config', args: { app_id: '730', profile_name: 'p'.repeat(101) } })],
  ])('rejects %s with 400', (_, p) => {
    expect(() => server.parseSignedRequest(body(p), NOW)).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('rejects a missing signature, non-JSON payload and oversized payload', () => {
    expect(() => server.parseSignedRequest({ payload: JSON.stringify(vote()) }, NOW)).toThrow(/signature/);
    expect(() => server.parseSignedRequest({ payload: '{nope', signature: sig }, NOW)).toThrow(/not JSON/);
    expect(() => server.parseSignedRequest({ payload: 'x'.repeat(3000), signature: sig }, NOW)).toThrow(/payload/);
  });

  test('the edge function verifies against the stored key, not the request key', () => {
    const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/client-write/index.ts'), 'utf8');
    expect(src).toContain('verifySignature(storedKey, payload, signature)');
    expect(src).toContain('isRateLimited("client-write"');
    expect(fs.readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8')).toMatch(/\[functions\.client-write\]\s*\nverify_jwt = false/);
  });
});

describe('signature round trip (browser signs, edge function verifies)', () => {
  async function signedRequest() {
    const { mod, calls } = loadClient();
    await mod.clientWrite(SB_URL, 'k', 'web-client-1', 'cast_vote', { app_id: '730', report_key: 'k', vote: 1 });
    return JSON.parse(calls[0].opts.body);
  }

  test('a genuine request verifies', async () => {
    const server = loadServer();
    const req = await signedRequest();
    const parsed = server.parseSignedRequest(req);
    await expect(server.verifySignature(req.publicKey, parsed.payload, parsed.signature)).resolves.toBe(true);
  });

  test('a tampered payload fails', async () => {
    const server = loadServer();
    const req = await signedRequest();
    const tampered = req.payload.replace('"vote":1', '"vote":-1');
    await expect(server.verifySignature(req.publicKey, tampered, req.signature)).resolves.toBe(false);
  });

  test("another browser's key fails (the server checks the stored key)", async () => {
    const server = loadServer();
    const mine = await signedRequest();
    const theirs = await signedRequest();
    await expect(server.verifySignature(theirs.publicKey, mine.payload, mine.signature)).resolves.toBe(false);
  });

  test('a non-P-256 key is refused without throwing', async () => {
    const server = loadServer();
    const req = await signedRequest();
    await expect(server.verifySignature({ kty: 'RSA' }, req.payload, req.signature)).resolves.toBe(false);
  });
});

function fakeVoteButtons({ up = 0, dn = 0, active = null } = {}) {
  const mk = (count, isActive) => {
    const classes = new Set(isActive ? ['active'] : []);
    const countEl = { textContent: String(count) };
    return {
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      querySelector: () => countEl,
      countEl,
    };
  };
  return { upBtn: mk(up, active === 'up'), dnBtn: mk(dn, active === 'dn') };
}

describe('castVote', () => {
  function loadVotes(writeImpl) {
    const writes = [];
    const toasts = [];
    const ctx = {
      SB_URL, SB_KEY: 'anon-key',
      getWebClientId: () => 'cid-1',
      clientWrite: (url, key, cid, action, args) => { writes.push({ cid, action, args }); return writeImpl(); },
      window: { ppToast: { error: (m) => toasts.push(m) } },
      console: quietConsole,
    };
    const mod = loadEsm(['js/app/api/votes.js'], ctx);
    return { mod, writes, toasts };
  }

  test('an upvote sends a signed cast_vote with 1', async () => {
    const { mod, writes, toasts } = loadVotes(async () => ({ ok: true, status: 200, data: { ok: true } }));
    const { upBtn, dnBtn } = fakeVoteButtons({ up: 2 });
    await mod.castVote(730, 'k1', 1, upBtn, dnBtn);
    expect(writes).toEqual([{ cid: 'cid-1', action: 'cast_vote', args: { app_id: '730', report_key: 'k1', vote: 1 } }]);
    expect(String(upBtn.countEl.textContent)).toBe('3');
    expect(toasts).toEqual([]);
  });

  test('clicking the active vote again clears it with 0', async () => {
    const { mod, writes } = loadVotes(async () => ({ ok: true, status: 200, data: { ok: true } }));
    const { upBtn, dnBtn } = fakeVoteButtons({ dn: 1, active: 'dn' });
    await mod.castVote('730', 'k1', -1, upBtn, dnBtn);
    expect(writes[0].args.vote).toBe(0);
    expect(String(dnBtn.countEl.textContent)).toBe('0');
  });

  test('a refused write (ban, bad signature) shows a toast', async () => {
    const { mod, toasts } = loadVotes(async () => ({ ok: false, status: 403, data: { error: 'client is banned' } }));
    const { upBtn, dnBtn } = fakeVoteButtons();
    await mod.castVote('730', 'k1', 1, upBtn, dnBtn);
    expect(toasts).toEqual(['Could not save your vote. Try again later.']);
  });

  test('a network error also shows a toast', async () => {
    const { mod, toasts } = loadVotes(() => Promise.reject(new Error('offline')));
    const { upBtn, dnBtn } = fakeVoteButtons();
    await mod.castVote('730', 'k1', -1, upBtn, dnBtn);
    expect(toasts).toEqual(['Could not save your vote. Check your connection.']);
  });
});

describe('deleteOwnCloudConfig', () => {
  function loadApi(writeImpl) {
    const writes = [];
    const ctx = {
      SB_URL, SB_KEY: 'anon-key',
      getWebClientId: () => 'cid-1',
      clientWrite: (url, key, cid, action, args) => { writes.push({ cid, action, args }); return writeImpl(); },
      console: quietConsole,
    };
    const mod = loadEsm(['js/app/api/supabase.js'], ctx);
    return { mod, writes };
  }

  test('sends a signed delete_cloud_config and reports the deleted count', async () => {
    const { mod, writes } = loadApi(async () => ({ ok: true, status: 200, data: { ok: true, deleted: 2 } }));
    await expect(mod.deleteOwnCloudConfig(730)).resolves.toEqual({ ok: true, deleted: 2 });
    expect(writes).toEqual([{ cid: 'cid-1', action: 'delete_cloud_config', args: { app_id: '730', profile_name: null } }]);
  });

  test('zero rows deleted is reported as a failure', async () => {
    const { mod } = loadApi(async () => ({ ok: true, status: 200, data: { ok: true, deleted: 0 } }));
    await expect(mod.deleteOwnCloudConfig('730')).resolves.toEqual({ ok: false, deleted: 0 });
  });

  test('a refused write and a network error both resolve not ok', async () => {
    const refused = loadApi(async () => ({ ok: false, status: 401, data: { error: 'signature does not match' } }));
    await expect(refused.mod.deleteOwnCloudConfig('730')).resolves.toEqual({ ok: false, deleted: 0 });
    const offline = loadApi(() => Promise.reject(new Error('offline')));
    await expect(offline.mod.deleteOwnCloudConfig('730')).resolves.toEqual({ ok: false, deleted: 0 });
  });
});
