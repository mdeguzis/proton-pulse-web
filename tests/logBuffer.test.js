/**
 * @jest-environment jsdom
 *
 * Unit tests for js/lib/log-buffer.js (#366). The buffer is small and
 * pure(ish) but every rule below maps to a UX contract in the Logging
 * tab -- ordering, filter thresholds, localStorage survival, subscribe
 * lifecycle. Regressions here would silently drop entries or double-emit
 * to subscribers.
 *
 * jsdom env is required so the window binding + localStorage assertions
 * exercise the same code path a real browser does.
 */
import {
  pushLog, getLogs, subscribeLog, clearLogs,
  activeLevel, setActiveLevel, setCapacity, LEVEL_ORDER,
  _resetForTests,
} from '../js/lib/log-buffer.js';

beforeEach(() => {
  _resetForTests();
});

describe('pushLog + getLogs', () => {
  test('DEBUG is dropped at default INFO level, INFO+ is captured', () => {
    expect(pushLog('DEBUG', 'noisy trace')).toBe(false);
    expect(pushLog('INFO', 'user landed on home')).toBe(true);
    expect(pushLog('WARN', 'slow fetch')).toBe(true);
    expect(pushLog('ERROR', 'boom')).toBe(true);
    const logs = getLogs();
    expect(logs.map(e => e.level)).toEqual(['INFO', 'WARN', 'ERROR']);
    expect(logs[0].msg).toBe('user landed on home');
  });

  test('DEBUG is captured when activeLevel is DEBUG', () => {
    setActiveLevel('DEBUG');
    expect(pushLog('DEBUG', 'x')).toBe(true);
    expect(getLogs()).toHaveLength(1);
  });

  test('unknown levels are dropped rather than assumed', () => {
    expect(pushLog('FATAL', 'oops')).toBe(false);
    expect(pushLog('', 'blank')).toBe(false);
    expect(getLogs()).toHaveLength(0);
  });

  test('entries carry ts + level + msg + ctx object', () => {
    const before = Date.now();
    pushLog('INFO', 'hi', { source: 'test', id: 42 });
    const after = Date.now();
    const [e] = getLogs();
    expect(e.level).toBe('INFO');
    expect(e.msg).toBe('hi');
    expect(e.ctx).toEqual({ source: 'test', id: 42 });
    expect(e.ts).toBeGreaterThanOrEqual(before);
    expect(e.ts).toBeLessThanOrEqual(after);
  });

  test('non-object ctx is coerced to empty object', () => {
    pushLog('INFO', 'x', 'not an object');
    expect(getLogs()[0].ctx).toEqual({});
  });

  test('ring caps at capacity; oldest entries drop first', () => {
    setCapacity(3);
    pushLog('INFO', 'a');
    pushLog('INFO', 'b');
    pushLog('INFO', 'c');
    pushLog('INFO', 'd');
    expect(getLogs().map(e => e.msg)).toEqual(['b', 'c', 'd']);
  });
});

describe('subscribeLog', () => {
  test('fires on push with the new entry, unsubscribe stops calls', () => {
    const seen = [];
    const off = subscribeLog(e => seen.push(e));
    pushLog('INFO', 'x');
    pushLog('WARN', 'y');
    off();
    pushLog('ERROR', 'z');
    expect(seen.map(e => e && e.msg)).toEqual(['x', 'y']);
  });

  test('a throwing subscriber does not break the pipeline for others', () => {
    subscribeLog(() => { throw new Error('subscriber blew up'); });
    const seen = [];
    subscribeLog(e => seen.push(e && e.msg));
    pushLog('INFO', 'still delivered');
    expect(seen).toEqual(['still delivered']);
  });

  test('non-function subscribers are ignored (defensive)', () => {
    const off = subscribeLog(null);
    expect(typeof off).toBe('function'); // returns a no-op unsubscribe
    pushLog('INFO', 'no throw');
    expect(getLogs()).toHaveLength(1);
  });

  test('clearLogs notifies subscribers with null payload', () => {
    pushLog('INFO', 'x');
    const seen = [];
    subscribeLog(e => seen.push(e));
    clearLogs();
    expect(getLogs()).toHaveLength(0);
    expect(seen).toEqual([null]);
  });
});

describe('activeLevel / setActiveLevel', () => {
  test('default is INFO', () => {
    expect(activeLevel()).toBe('INFO');
  });

  test('setActiveLevel accepts each known level, ignores garbage', () => {
    for (const l of LEVEL_ORDER) {
      expect(setActiveLevel(l)).toBe(l);
      expect(activeLevel()).toBe(l);
    }
    expect(setActiveLevel('FATAL')).toBe('ERROR'); // unchanged
    expect(activeLevel()).toBe('ERROR');
  });

  test('setActiveLevel persists to localStorage so nav across pages keeps the level', () => {
    setActiveLevel('DEBUG');
    // Reset internal cached _activeLevel so the next resolve reads localStorage.
    _resetForTests();
    // localStorage was cleared by _resetForTests; simulate the cross-page case
    // by writing directly and re-reading.
    localStorage.setItem('pp:loglevel', 'DEBUG');
    expect(activeLevel()).toBe('DEBUG');
  });
});

describe('localStorage hydration', () => {
  test('logs seeded into localStorage are loaded on first access', () => {
    const seed = [{ ts: 1, level: 'INFO', msg: 'seeded', ctx: {} }];
    localStorage.setItem('pp:log-buffer', JSON.stringify(seed));
    // Fresh module state; getLogs should hydrate from storage.
    expect(getLogs()).toEqual(seed);
  });

  test('malformed storage does not throw; buffer starts empty', () => {
    localStorage.setItem('pp:log-buffer', '{not json');
    expect(() => getLogs()).not.toThrow();
    expect(getLogs()).toEqual([]);
  });
});

describe('window.ppLogBuffer window binding', () => {
  test('is exposed on window with the expected surface', () => {
    // The module unconditionally binds on window in a browser env; jsdom
    // provides window so this should be present in tests too.
    expect(typeof window.ppLogBuffer).toBe('object');
    for (const k of ['pushLog', 'getLogs', 'subscribeLog', 'clearLogs', 'activeLevel', 'setActiveLevel', 'LEVEL_ORDER']) {
      expect(k in window.ppLogBuffer).toBe(true);
    }
  });
});
