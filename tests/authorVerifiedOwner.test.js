/**
 * Verifies the "Verified owner" badge shows up in the author block only when a
 * report has ownerVerified === true (#199). Guards against the badge leaking
 * onto ProtonDB reports or legacy user_configs rows without the flag.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

function loadSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/^import\s.*$/gm, '')
    .replace(/^export\s+(async\s+)?(function|const|let|var|class)\s/gm, '$1$2 ')
    .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '');
}

function makeCtx() {
  const ctx = vm.createContext({ console });
  // author.js pulls in ATOM_ICON_SVG + helpers but the render function only
  // needs `esc`, `getAuthorIdentity`, and the module-scope SVG constant.
  // author.js declares ATOM_ICON_SVG itself; only stub the two helpers that
  // would otherwise be undefined because we strip its imports.
  vm.runInContext(`
    function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
    function getAuthorIdentity(r) {
      return { displayName: r.displayName || 'Anon', subtitle: r.subtitle || '', kind: r.kind || 'anon' };
    }
  `, ctx);
  vm.runInContext(loadSrc('js/app/components/author.js'), ctx);
  return ctx;
}

describe('renderAuthorBlock verified owner badge', () => {
  const ctx = makeCtx();

  test('omits the badge when ownerVerified is falsy', () => {
    const html = ctx.renderAuthorBlock({ clientId: 'c1' });
    expect(html).not.toMatch(/Verified owner/);
    expect(html).not.toMatch(/author-verified/);
  });

  test('renders the badge when ownerVerified is true (camelCase)', () => {
    const html = ctx.renderAuthorBlock({ clientId: 'c1', ownerVerified: true });
    expect(html).toMatch(/Verified owner/);
    expect(html).toMatch(/class="author-verified"/);
  });

  test('also accepts snake_case owner_verified from raw supabase rows', () => {
    const html = ctx.renderAuthorBlock({ clientId: 'c1', owner_verified: true });
    expect(html).toMatch(/Verified owner/);
  });

  test('does not render for falsy but present flag values', () => {
    const html = ctx.renderAuthorBlock({ clientId: 'c1', ownerVerified: false, owner_verified: null });
    expect(html).not.toMatch(/Verified owner/);
  });
});
