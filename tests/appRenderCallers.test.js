/**
 * Catches "ReferenceError: someFunc is not defined" bugs inside the render
 * path before they break the live site.
 *
 * The Wukong "Loading reports..." hang was caused by renderConfigCard calling
 * renderFormResponses(c), a name that was never defined. render() threw, the
 * page stayed on the placeholder, and our existing tests didn't catch it
 * because none of them ever invoked renderConfigCard.
 *
 * This test loads app.js + its companion bundles into a vm context with the
 * minimum browser stubs needed for top-level execution, then calls
 * renderConfigCard against a representative ProtonDB-bucket row (the shape
 * that triggered the bug on Wukong) and asserts it produces non-empty HTML
 * without throwing. Any future "function exists in one file but called by
 * another after a rename" mistake fails this test loudly.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function noop() {}

function stubElement() {
  const el = {
    innerHTML: '', textContent: '', value: '', hidden: false,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, dataset: {},
    addEventListener: noop, removeEventListener: noop,
    appendChild: noop, removeChild: noop,
    setAttribute: noop, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    focus: noop, blur: noop, click: noop,
  };
  return el;
}

function makeContext() {
  const localStorageStore = {};
  const ctx = {
    console,
    Promise, JSON, Object, Array, Number, String, Boolean, RegExp, Error,
    Date, Math, Map, Set, WeakMap, WeakSet, Symbol, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    fetch: () => Promise.resolve({ ok: false, status: 500, json: async () => [] }),
    localStorage: {
      getItem: k => (k in localStorageStore ? localStorageStore[k] : null),
      setItem: (k, v) => { localStorageStore[k] = String(v); },
      removeItem: k => { delete localStorageStore[k]; },
    },
    crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000000' },
    navigator: { userAgent: 'jest-jsdom' },
    location: { hash: '', search: '', pathname: '/app.html', href: 'http://test/app.html', origin: 'http://test' },
    document: (() => {
      // Cache stub elements per id so the same node round-trips across calls.
      const cache = {};
      return {
        readyState: 'loading',
        getElementById: id => (cache[id] = cache[id] || stubElement()),
        querySelector: () => stubElement(),
        querySelectorAll: () => [],
        createElement: () => stubElement(),
        addEventListener: noop,
        removeEventListener: noop,
        body: stubElement(),
        head: stubElement(),
        documentElement: stubElement(),
      };
    })(),
    addEventListener: noop,
    removeEventListener: noop,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  // Supabase UMD is loaded via CDN at runtime; provide just enough surface so
  // supabase-client.js doesn't crash when it tries to read window.supabase
  ctx.supabase = {
    createClient: () => ({
      auth: {
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: noop } } }),
        signInWithOAuth: () => Promise.resolve({ data: null, error: null }),
        signOut: () => Promise.resolve({ error: null }),
      },
      from: () => ({
        select: () => Promise.resolve({ data: [], error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => Promise.resolve({ data: null, error: null }),
        delete: () => Promise.resolve({ data: null, error: null }),
      }),
    }),
  };
  return ctx;
}

// app.js was split into js/app/ ES modules. The scoring/submit companions are
// still classic global scripts; the js/app modules use import/export, so we
// strip those lines and concatenate everything into one vm scope (same approach
// as adminAuth.test.js). Classic files load first so the config bridge captures
// their globals via window.
const CLASSIC_FILES = [
  'supabase-client.js',
  'gh-gist.js',
  'app-scoring.js',
  'app-submit.js',
];
const APP_MODULE_FILES = [
  'js/app/config.js', 'js/app/utils.js', 'js/app/data.js', 'js/app/votes.js',
  'js/app/signals.js', 'js/app/deck-status.js', 'js/app/author.js',
  'js/app/config-cards.js', 'js/app/report-card.js', 'js/app/home.js',
  'js/app/search.js', 'js/app/game-page.js', 'js/app/router.js',
];

function stripModuleSyntax(src) {
  return src
    .replace(/^(import|export\s+\{[^}]*\}\s+from|export\s+default)\s.*$/gm, '')
    .replace(/^export\s+(async\s+)?(function|class|const|let|var)\s/gm, '$1$2 ')
    // Drop the config.js window bridge (const X = window.X): in the flattened vm
    // scope the classic scoring/submit scripts already declare those globals, so
    // re-declaring them throws "already declared". Real module scopes don't collide.
    .replace(/^(?:const|let|var)\s+(\w+)\s*=\s*window\.\1\s*;?\s*$/gm, '');
}

function loadBundle() {
  const ctx = makeContext();
  ctx.window = ctx; // window.X resolves to globals (config bridge + window.location)
  vm.createContext(ctx);
  const files = [
    ...CLASSIC_FILES.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]),
    ...APP_MODULE_FILES.map(f => [f, stripModuleSyntax(fs.readFileSync(path.join(ROOT, f), 'utf8'))]),
  ];
  for (const [f, src] of files) {
    try {
      vm.runInContext(src, ctx, { filename: f });
    } catch (e) {
      // top-level throws here would mask the test's signal -- surface them
      throw new Error(`Top-level throw loading ${f}: ${e.message}\n${e.stack}`);
    }
  }
  return ctx;
}

describe('renderConfigCard render path', () => {
  let ctx;
  beforeAll(() => { ctx = loadBundle(); });

  test('renders a ProtonDB-bucket row without throwing (the Wukong shape)', () => {
    // Shape mirrors what fetchCdn returns for ProtonDB reports, after being
    // tagged with _kind='config' / _bucket='protondb' by the merge in
    // renderGamePage. This is the EXACT shape that crashed on Wukong.
    const protondbConfig = {
      appId: '2358720',
      cpu: 'AMD Ryzen 9 9950X3D 16-Core',
      gpu: 'NVIDIA GeForce RTX 5070 Ti',
      gpuDriver: 'NVIDIA 590.48.01',
      ram: '62 GB',
      os: 'Arch Linux',
      kernel: '6.12.65-1-lts',
      protonVersion: '10.0-3',
      rating: 'borked',
      duration: 'oneToFourHours',
      timestamp: 1768508003,
      title: 'Black Myth: Wukong',
      source: 'protondb',
      _kind: 'config',
      _bucket: 'protondb',
    };
    expect(typeof ctx.renderConfigCard).toBe('function');
    const html = ctx.renderConfigCard(protondbConfig, 0, {}, {});
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(100);
    // Sanity: rendered card includes the proton version + source label
    expect(html).toContain('10.0-3');
    expect(html).toMatch(/ProtonDB/);
  });

  test('renders a pulse-config row with form responses without throwing', () => {
    const pulseConfig = {
      appId: 2358720,
      configId: 42,
      clientId: 'aaaa-bbbb-cccc',
      profileName: 'Test profile',
      protonVersion: '10.0-3',
      launchOptions: 'PROTON_USE_WINED3D=1 %command%',
      enabledVars: { DXVK_HUD: true },
      cpu: 'AMD', gpu: 'NVIDIA', gpuDriver: '590', gpuVendor: 'nvidia',
      ram: '32 GB', os: 'SteamOS', kernel: '6.16',
      timestamp: 1768508003,
      source: 'web-linux',
      isNonSteam: false,
      formResponses: { canInstall: 'yes', canStart: 'yes', canPlay: 'yes', verdict: 'yes' },
      _kind: 'config', _bucket: 'pulse-config',
    };
    expect(() => ctx.renderConfigCard(pulseConfig, 1, {}, {})).not.toThrow();
    const html = ctx.renderConfigCard(pulseConfig, 1, {}, {});
    expect(html).toContain('Test profile');
    // form responses should render inside the .fr-section wrapper
    expect(html).toContain('fr-section');
  });

  test('buildFormRows exists and is callable (regression for renderFormResponses typo)', () => {
    expect(typeof ctx.buildFormRows).toBe('function');
    // The typo'd name must NOT be defined anywhere -- if a future change
    // re-introduces it, callers might silently switch back and the bug
    // returns.
    expect(ctx.renderFormResponses).toBeUndefined();
  });
});
