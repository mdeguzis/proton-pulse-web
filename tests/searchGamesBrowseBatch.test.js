/**
 * #437: browseGames() + getGamesByIds() wrappers for the search-games edge fn.
 * These let browse grids and library synth stop downloading the 11.8MB
 * search-index.json blob. Tests mock fetch and assert the URL contract + the
 * shape the callers rely on.
 */
const path = require('path');

let browseGames, getGamesByIds;
beforeAll(async () => {
  ({ browseGames, getGamesByIds } = await import(
    path.join(__dirname, '..', 'js', 'app', 'api', 'search-games.js')
  ));
});

function mockFetch(body, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
}

afterEach(() => { delete global.fetch; });

describe('browseGames', () => {
  test('builds a browse URL with store/sort/limit/offset and no q', async () => {
    global.fetch = mockFetch({ results: [{ appId: '10' }], total: 500, offset: 0, limit: 48, took_ms: 3 });
    const out = await browseGames({ store: 'gog', sort: 'popular', limit: 48, offset: 96 });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('browse')).toBe('1');
    expect(url.searchParams.get('store')).toBe('gog');
    expect(url.searchParams.get('sort')).toBe('popular');
    expect(url.searchParams.get('limit')).toBe('48');
    expect(url.searchParams.get('offset')).toBe('96');
    expect(url.searchParams.has('q')).toBe(false);
    expect(out.results).toEqual([{ appId: '10' }]);
    expect(out.total).toBe(500);
  });

  test('clamps limit to [1,100] and offset to >= 0', async () => {
    global.fetch = mockFetch({ results: [], total: 0 });
    await browseGames({ limit: 9999, offset: -5 });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('0');
  });

  test('passes include flags only when set', async () => {
    global.fetch = mockFetch({ results: [], total: 0 });
    await browseGames({ store: 'all', includeDelisted: true });
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('include_delisted')).toBe('true');
    expect(url.searchParams.has('include_adult')).toBe(false);
  });

  test('returns an empty result set on a non-2xx response', async () => {
    global.fetch = mockFetch({}, false, 502);
    const out = await browseGames({ store: 'epic' });
    expect(out.results).toEqual([]);
    expect(out.total).toBe(0);
  });

  test('re-throws AbortError so callers can cancel', async () => {
    const err = new Error('aborted'); err.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(err);
    await expect(browseGames({})).rejects.toThrow('aborted');
  });
});

describe('getGamesByIds', () => {
  test('sends a de-duped, digits-only ids param and returns a Map keyed by appId', async () => {
    global.fetch = mockFetch({ results: [
      { appId: '10', title: 'Counter-Strike', tier: 'gold' },
      { appId: '220', title: 'Half-Life 2', tier: 'platinum' },
    ] });
    const map = await getGamesByIds([10, '220', '220', 'abc', '']);
    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('ids')).toBe('10,220');
    expect(map.get('10').title).toBe('Counter-Strike');
    expect(map.get('220').tier).toBe('platinum');
    expect(map.size).toBe(2);
  });

  test('short-circuits with an empty Map and no fetch when no valid ids', async () => {
    global.fetch = mockFetch({ results: [] });
    const map = await getGamesByIds(['', 'xyz', null, undefined]);
    expect(map.size).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns an empty Map on a non-2xx response', async () => {
    global.fetch = mockFetch({}, false, 500);
    const map = await getGamesByIds([10, 20]);
    expect(map.size).toBe(0);
  });
});
