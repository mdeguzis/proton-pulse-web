// In-memory ring buffer for frontend logs (#366). Mobile debugging without
// remote devtools was painful -- console.log is invisible on a phone and the
// existing logFrontendEvent path only hits the server. This buffer captures
// every log locally so an admin can open the Logging tab and see the last N
// entries in the same page they are debugging.
//
// Ring size is intentionally small (default 500) so the whole thing survives
// in localStorage and a page reload does not lose recent context. localStorage
// (rather than sessionStorage) is deliberate: the admin Logging tab must see
// logs written from OTHER tabs -- open the game page in one tab, open admin
// in another, diagnose. sessionStorage is per-tab and would show 0 captures.
//
// Level order for filtering: DEBUG < INFO < WARN < ERROR. A URL flag
// ?loglevel=debug (or localStorage 'pp:loglevel') cranks capture verbosity;
// default is INFO so casual visitors do not pay for debug-noise storage.

const STORAGE_KEY = 'pp:log-buffer';
const LEVEL_PREF_KEY = 'pp:loglevel';
const DEFAULT_CAPACITY = 500;
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

let _buffer = null;
let _capacity = DEFAULT_CAPACITY;
let _subscribers = new Set();
let _activeLevel = null;

function _levelIndex(level) {
  const idx = LEVELS.indexOf(String(level || '').toUpperCase());
  return idx === -1 ? LEVELS.indexOf('INFO') : idx;
}

// Read the URL / localStorage / default in that order so a one-shot debug
// session can be started by appending ?loglevel=debug to any page URL.
function _resolveActiveLevel() {
  if (_activeLevel) return _activeLevel;
  try {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const fromUrl = (params.get('loglevel') || '').toUpperCase();
    if (LEVELS.includes(fromUrl)) {
      // Persist so subsequent nav within the same session keeps the level.
      try { localStorage.setItem(LEVEL_PREF_KEY, fromUrl); } catch { /* private mode */ }
      _activeLevel = fromUrl;
      return _activeLevel;
    }
  } catch { /* not in browser */ }
  try {
    const fromStore = (localStorage.getItem(LEVEL_PREF_KEY) || '').toUpperCase();
    if (LEVELS.includes(fromStore)) {
      _activeLevel = fromStore;
      return _activeLevel;
    }
  } catch { /* no storage */ }
  _activeLevel = 'INFO';
  return _activeLevel;
}

// Hydrate from localStorage on first access. Guards against storage-full
// or private-mode SecurityError (Safari), and against a malformed JSON blob
// (start fresh rather than error the whole page).
function _load() {
  if (_buffer) return _buffer;
  _buffer = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) _buffer = parsed.slice(-_capacity);
    }
  } catch { _buffer = []; }
  return _buffer;
}

function _persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_buffer)); } catch { /* quota */ }
}

// Push a log entry. Filtered by active level -- DEBUG entries are dropped
// entirely when the level is INFO or above. Returns true when the entry
// was captured, false when it was dropped (useful in tests).
export function pushLog(level, msg, ctx) {
  const lvl = String(level || '').toUpperCase();
  if (!LEVELS.includes(lvl)) return false;
  if (_levelIndex(lvl) < _levelIndex(_resolveActiveLevel())) return false;
  _load();
  const entry = {
    ts: Date.now(),
    level: lvl,
    msg: String(msg || ''),
    ctx: ctx && typeof ctx === 'object' ? ctx : {},
  };
  _buffer.push(entry);
  if (_buffer.length > _capacity) _buffer.splice(0, _buffer.length - _capacity);
  _persist();
  for (const fn of _subscribers) {
    try { fn(entry); } catch { /* subscriber threw -- do not break the pipeline */ }
  }
  return true;
}

// Return a shallow copy so callers cannot mutate the internal ring in place.
export function getLogs() {
  return _load().slice();
}

// Subscribe to new log entries. Returns an unsubscribe function.
export function subscribeLog(fn) {
  if (typeof fn !== 'function') return () => {};
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

export function clearLogs() {
  _buffer = [];
  _persist();
  for (const fn of _subscribers) {
    try { fn(null); } catch { /* ignore */ }
  }
}

// Test hooks + external inspection. Never touch _activeLevel via env outside
// tests -- callers should use setActiveLevel below so subscribers can react.
export function activeLevel() {
  return _resolveActiveLevel();
}

export function setActiveLevel(level) {
  const lvl = String(level || '').toUpperCase();
  if (!LEVELS.includes(lvl)) return activeLevel();
  _activeLevel = lvl;
  try { localStorage.setItem(LEVEL_PREF_KEY, lvl); } catch { /* ignore */ }
  return _activeLevel;
}

export function setCapacity(n) {
  if (!Number.isFinite(n) || n < 1) return _capacity;
  _capacity = Math.floor(n);
  _load();
  if (_buffer.length > _capacity) {
    _buffer.splice(0, _buffer.length - _capacity);
    _persist();
  }
  return _capacity;
}

export const LEVEL_ORDER = LEVELS.slice();

// Test-only reset. Avoids state leaking between jest cases.
export function _resetForTests() {
  _buffer = null;
  _capacity = DEFAULT_CAPACITY;
  _subscribers = new Set();
  _activeLevel = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(LEVEL_PREF_KEY); } catch { /* ignore */ }
}

// Expose on window so the plain-<script> paths (js/lib/analytics.js,
// js/lib/topbar.js's logFrontendEvent) can push without an import. The
// ES-module admin bundle also gets a stable reference this way -- one
// buffer instance shared across every consumer on the page.
if (typeof window !== 'undefined') {
  window.ppLogBuffer = { pushLog, getLogs, subscribeLog, clearLogs, activeLevel, setActiveLevel, LEVEL_ORDER };
}
