/**
 * #241: "Exclude native" home filter backed by native-linux.json.
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm');

function load(fetchImpl) {
  return loadEsm(['js/app/lib/native-linux.js'], {
    fetch: fetchImpl,
    dataUrl: (name) => Promise.resolve(name),
    console: { debug: () => {}, warn: () => {} },
  });
}
const ok = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve(body) });

describe('loadNativeLinux', () => {
  test('returns the native ids as a Set of strings', async () => {
    const { loadNativeLinux } = load(jest.fn().mockResolvedValue(ok({ checked: 3, native: [570, '730'] })));
    const set = await loadNativeLinux();
    expect([...set].sort()).toEqual(['570', '730']);
  });

  test('loads once and shares the result', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok({ checked: 1, native: ['570'] }));
    const { loadNativeLinux } = load(fetchImpl);
    await Promise.all([loadNativeLinux(), loadNativeLinux()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a non-ok response', { ok: false, status: 404 }, /HTTP 404/],
    ['the Pages HTML fallback', { ok: true, status: 200, headers: { get: () => 'text/html' }, json: () => Promise.reject(new Error('<')) }, /returned HTML/],
    ['a payload without a native list', ok({ checked: 5 }), /no native list/],
    ['a file where Steam answered nothing', ok({ checked: 0, native: [], error: 'OSError: down' }), /checked no apps: OSError: down/],
  ])('rejects %s, and retries on the next call', async (_name, response, err) => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(ok({ checked: 1, native: ['570'] }));
    const { loadNativeLinux } = load(fetchImpl);
    await expect(loadNativeLinux()).rejects.toThrow(err);
    await expect(loadNativeLinux()).resolves.toEqual(new Set(['570']));
  });
});

describe('filterByNative', () => {
  const { filterByNative } = load(jest.fn());
  const rows = [{ appId: 570 }, { appId: '1245620' }, { appId: 'gog:1' }];
  const native = new Set(['570']);

  test('exclude drops native games and keeps unknown / non-Steam ones', () => {
    expect(filterByNative(rows, new Set(['exclude']), native).map((r) => r.appId)).toEqual(['1245620', 'gog:1']);
  });

  test('all, empty or no map keeps everything', () => {
    expect(filterByNative(rows, new Set(['all']), native)).toBe(rows);
    expect(filterByNative(rows, new Set(), native)).toBe(rows);
    expect(filterByNative(rows, new Set(['exclude']), null)).toBe(rows);
  });
});

describe('home wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js/app/components/home.js'), 'utf8');

  test('the chip group exists with All and Exclude native', () => {
    expect(src).toMatch(/id="home-native-checks"/);
    expect(src).toMatch(/data-value="exclude"[^>]*>Exclude native</);
  });

  test('both filter chains, save, restore, badge and clear include it', () => {
    expect((src.match(/nativeSel, nativeSet\), textFilter\)/g) || []).length).toBe(2);
    expect(src).toMatch(/native: \[\.\.\.nativeSel\]/);
    expect(src).toMatch(/nativeSel = new Set\(saved\.native \|\| \[\]\)/);
    expect(src).toMatch(/_applyPillSelection\(nativeGroup, saved\.native\)/);
    expect(src).toMatch(/acSel\.size \+ nativeSel\.size/);
    expect(src).toMatch(/vrGroup, acGroup, nativeGroup\]\.forEach/);
  });

  test('an unusable file hides the group instead of filtering nothing', () => {
    const fn = src.slice(src.indexOf('async function _ensureNativeSet'));
    expect(fn.slice(0, 600)).toMatch(/nativeGroup\.hidden = true/);
    expect(src).toMatch(/if \(_active\(nativeSel\)\) await _ensureNativeSet\(\)/);
  });
});
