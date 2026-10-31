/**
 * readDataJson (#587): a data file Cloudflare Pages never deployed comes back
 * as the SPA fallback, HTML with a 200. res.ok cannot see that, so callers
 * that did `res.json().catch(() => ({}))` read a missing file as an empty one.
 * This pins that every failure shape returns an error and no data.
 */
const { readDataJson } = require('../js/lib/data-url.js');

const resp = ({ ok = true, status = 200, type = 'application/json', body = {}, badJson = false } = {}) => ({
  ok,
  status,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
  json: () => (badJson ? Promise.reject(new SyntaxError("Unexpected token '<'")) : Promise.resolve(body)),
});

describe('readDataJson', () => {
  test('returns the parsed body for a JSON response', async () => {
    const out = await readDataJson(resp({ body: { 10: { status: 'missing' } } }), 'game-images-cache.json');
    expect(out).toEqual({ data: { 10: { status: 'missing' } }, error: null });
  });

  test('an empty JSON object is data, not an error', async () => {
    // Empty is a real state; it must stay distinguishable from a failure.
    expect(await readDataJson(resp({ body: {} }), 'x.json')).toEqual({ data: {}, error: null });
  });

  test('the SPA fallback (200 text/html) is an error, not an empty cache', async () => {
    const out = await readDataJson(resp({ type: 'text/html; charset=utf-8', body: '<!doctype html>' }), 'game-images-cache.json');
    expect(out.data).toBeNull();
    expect(out.error).toBe('game-images-cache.json: served HTML, file is not deployed');
  });

  test('a non-2xx response reports the status', async () => {
    const out = await readDataJson(resp({ ok: false, status: 404 }), 'nonsteam-images-cache.json');
    expect(out).toEqual({ data: null, error: 'nonsteam-images-cache.json: HTTP 404' });
  });

  test('a rejected fetch (null response) is a network error', async () => {
    expect(await readDataJson(null, 'search-index.json')).toEqual({ data: null, error: 'search-index.json: network error' });
  });

  test('a body that is not JSON reports the parse error', async () => {
    const out = await readDataJson(resp({ type: '', badJson: true }), 'x.json');
    expect(out.data).toBeNull();
    expect(out.error).toMatch(/^x\.json: invalid JSON \(Unexpected token/);
  });

  test('a response without headers still parses', async () => {
    const r = resp({ body: [1] });
    delete r.headers;
    expect(await readDataJson(r, 'x.json')).toEqual({ data: [1], error: null });
  });
});
