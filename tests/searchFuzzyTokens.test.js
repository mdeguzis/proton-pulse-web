/**
 * Guards the tokenized fuzzy match in js/app/lib/search-match.js. Before
 * this the search dropdown did title.toLowerCase().includes(query), which
 * broke on any punctuation or filler word between tokens. Real user report:
 * "halo master chief" missed "Halo: The Master Chief Collection" because
 * of the ": " and "The " between the words. Multi-token match normalizes
 * both sides + requires every token to appear anywhere in the title.
 */
import { matchEntries, normalizeSearchable, titleMatchesTokens } from '../js/app/lib/search-match.js';

const HALO = [976730, 'Halo: The Master Chief Collection', 'gold', 4200, 12, 'steam'];
const BALDUR = [1091500, "Baldur's Gate 3", 'gold', 3000, 8, 'steam'];
const MASTER_OF_ORION = [123, 'Master of Orion', 'silver', 100, 0, 'steam'];

describe('normalizeSearchable', () => {
  test('lowercases + collapses non-alphanumeric runs to single spaces', () => {
    expect(normalizeSearchable("Halo: The Master's Chief!")).toBe('halo the master s chief');
  });
  test('trims leading + trailing whitespace introduced by normalization', () => {
    expect(normalizeSearchable('  ,,, Cat  Chess  ')).toBe('cat chess');
  });
  test('empty / null / undefined -> empty string', () => {
    expect(normalizeSearchable('')).toBe('');
    expect(normalizeSearchable(null)).toBe('');
    expect(normalizeSearchable(undefined)).toBe('');
  });
});

describe('titleMatchesTokens', () => {
  test('requires every token to appear somewhere in the normalized title', () => {
    expect(titleMatchesTokens('Halo: The Master Chief Collection', ['halo', 'master', 'chief'])).toBe(true);
  });
  test('order-independent', () => {
    expect(titleMatchesTokens('Halo: The Master Chief Collection', ['chief', 'halo'])).toBe(true);
  });
  test('missing token fails', () => {
    expect(titleMatchesTokens('Halo: The Master Chief Collection', ['halo', 'reach'])).toBe(false);
  });
  test('empty token array -> false (avoids matching everything)', () => {
    expect(titleMatchesTokens('anything', [])).toBe(false);
  });
});

describe('matchEntries', () => {
  test('"halo master chief" matches "Halo: The Master Chief Collection"', () => {
    const hits = matchEntries([HALO, MASTER_OF_ORION], 'halo master chief', 10);
    expect(hits.map(r => r[0])).toEqual([976730]);
  });

  test('order-independent: "chief master halo" also matches', () => {
    expect(matchEntries([HALO], 'chief master halo', 10).length).toBe(1);
  });

  test('extra punctuation in query is normalized away', () => {
    expect(matchEntries([HALO], 'halo:master chief!', 10).length).toBe(1);
  });

  test('single-token queries still work like the old includes', () => {
    expect(matchEntries([HALO, BALDUR], 'baldur', 10).map(r => r[0])).toEqual([1091500]);
  });

  test('numeric queries short-circuit to id.startsWith (no title fuzz)', () => {
    const hits = matchEntries([HALO, [9767301, 'Some Other Game', 'silver', 10, 0, 'steam']], '976730', 10);
    // Both ids start with "976730"; the naive-substring fallback that used to
    // return everything with "976730" in the title is bypassed.
    expect(hits.map(r => r[0])).toEqual([976730, 9767301]);
  });

  test('empty / whitespace / all-punctuation queries return nothing', () => {
    expect(matchEntries([HALO], '', 10)).toEqual([]);
    expect(matchEntries([HALO], '   ', 10)).toEqual([]);
    expect(matchEntries([HALO], '   ,,, !!!', 10)).toEqual([]);
  });

  test('AND across tokens: "master chief" excludes Master of Orion', () => {
    const hits = matchEntries([HALO, MASTER_OF_ORION], 'master chief', 10);
    expect(hits.map(r => r[0])).toEqual([976730]);
  });

  test('id.startsWith still contributes hits alongside title fuzz', () => {
    // A query like "976" matches HALO by id (startswith on numeric id)
    // even though it does not tokenize into a title match.
    const hits = matchEntries([HALO, BALDUR], '976', 10);
    expect(hits.map(r => r[0])).toEqual([976730]);
  });

  test('respects the limit parameter', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [i + 1, `Halo Fake Copy ${i}`, 'gold', 1, 0, 'steam']);
    expect(matchEntries(rows, 'halo fake', 5).length).toBe(5);
  });

  test('null / empty entries returns empty', () => {
    expect(matchEntries(null, 'halo', 10)).toEqual([]);
    expect(matchEntries([], 'halo', 10)).toEqual([]);
  });
});
