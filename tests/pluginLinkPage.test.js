const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Source moved to the layered module js/plugin-link/main.js. Jest has no ESM
// transform here, so strip the `import` line and run the IIFE body in a vm.
// The SupaAuth import resolves to the stub on ctx (var window = ctx in SHIM).
const SRC = fs
  .readFileSync(path.join(__dirname, '..', 'js', 'plugin-link', 'main.js'), 'utf8')
  .replace(/^import\s.*$/gm, '');

const SHIM = `
var window = ctx;
var location = { pathname: '/plugin-link.html', href: 'https://www.proton-pulse.com/plugin-link.html', hash: '', search: '' };
var history = { replaceState: function(){} };
var navigator = { clipboard: { writeText: function(){ return Promise.resolve(); } } };
var SUPABASE_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co';
${SRC}
ctx.__getPluginLinkCodeFromLocation = window.PluginLinkPage.getPluginLinkCodeFromLocation;
ctx.__buildCompanionLink = window.PluginLinkPage.buildCompanionLink;
`;

function makeCtx() {
  const noop = jest.fn();
  const stubEl = () => ({
    textContent: '',
    href: '',
    disabled: false,
    dataset: {},
    addEventListener: noop,
    setAttribute: noop,
  });

  const ctx = {
    ctx: null,
    document: { getElementById: jest.fn(() => stubEl()) },
    SupaAuth: {
      getSession: jest.fn().mockResolvedValue(null),
      authHeaders: jest.fn().mockResolvedValue({}),
      loginWithSteam: jest.fn(),
    },
    fetch: jest.fn(),
    console: { error: noop, log: noop, warn: noop },
    URL,
    URLSearchParams,
    Promise,
    JSON,
    String,
    Error,
    navigator: { clipboard: { writeText: jest.fn().mockResolvedValue() } },
  };
  ctx.window = ctx;
  ctx.location = { pathname: '/plugin-link.html', href: 'https://www.proton-pulse.com/plugin-link.html', hash: '', search: '' };
  ctx.ctx = ctx;
  vm.createContext(ctx);
  vm.runInContext(SHIM, ctx);
  return ctx;
}

describe('plugin link splash helpers', () => {
  test('reads pluginLinkCode from the normal query string', () => {
    const ctx = makeCtx();
    expect(ctx.__getPluginLinkCodeFromLocation({
      search: '?pluginLinkCode=ABCD-1234',
      hash: '',
    })).toBe('ABCD-1234');
  });

  test('falls back to pluginLinkCode inside the hash query', () => {
    const ctx = makeCtx();
    expect(ctx.__getPluginLinkCodeFromLocation({
      search: '',
      hash: '#decky?pluginLinkCode=ABCD-1234',
    })).toBe('ABCD-1234');
  });

  test('builds a phone-friendly companion link with the code in search', () => {
    const ctx = makeCtx();
    expect(ctx.__buildCompanionLink('abcd-1234', 'https://www.proton-pulse.com/plugin-link.html#deck')).toBe(
      'https://www.proton-pulse.com/plugin-link.html?pluginLinkCode=ABCD-1234',
    );
  });
});
