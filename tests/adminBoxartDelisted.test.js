/**
 * Box Art Manager exposes delisted rows with a visible indicator + a
 * dedicated filter (all / hide / only). #441.
 *
 * The pipeline flags games as delisted in search-index column 7 when
 * Steam's appdetails returns success=false + the store page 302s to the
 * homepage, OR PCGamingWiki cross-check says Steam no longer lists the
 * title. Public browse pages hide these by default; the admin box-art
 * manager needs the opposite -- show them, tag them, and let admin
 * narrow the view when triaging delisted covers.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'components', 'boxart.js'),
  'utf8',
);

describe('boxart manager exposes delisted state (#441)', () => {
  test('_buildRows reads column 7 of the search-index row and stores it on the row object', () => {
    // Column 7 is the pipeline-emitted delisted flag; without reading it
    // the manager was blind to which rows are delisted.
    expect(SRC).toContain('const isDelisted = row.length > 7 && row[7] === true');
    expect(SRC).toContain('delisted: isDelisted');
  });

  test('_buildRows accepts a delisted filter mode with hide / only semantics', () => {
    // Default 'all' shows every row (admin manages both listed + delisted
    // covers). 'hide' drops delisted; 'only' narrows to delisted-only.
    expect(SRC).toContain("if (delisted === 'hide' && isDelisted) return");
    expect(SRC).toContain("if (delisted === 'only' && !isDelisted) return");
    expect(SRC).toMatch(/function _buildRows\([\s\S]*?\{ store, textFilter, scope, status, delisted \}/);
  });

  test('rows render a DELISTED badge next to the title when the row is flagged', () => {
    expect(SRC).toContain("r.delisted");
    expect(SRC).toContain('>DELISTED<');
    expect(SRC).toContain('data-delisted="${r.delisted ? \'1\' : \'0\'}"');
  });

  test('filter panel ships a dedicated delisted select with the three modes', () => {
    expect(SRC).toContain('id="boxart-delisted"');
    expect(SRC).toContain('>All (incl. delisted)<');
    expect(SRC).toContain('>Hide delisted<');
    expect(SRC).toContain('>Only delisted<');
  });

  test('delisted filter state is persisted in the URL as bxd', () => {
    // Matches the bx* param convention used by store/scope/status so
    // refresh + browser back restore whatever the admin had set.
    expect(SRC).toContain("_initialParams.get('bxd')");
    expect(SRC).toContain("set('bxd',  state.delisted,   'all')");
  });

  test('refilter passes the delisted mode into _buildRows', () => {
    // Otherwise the select would render but never actually influence the
    // row list -- classic wiring miss.
    expect(SRC).toMatch(/_buildRows\(indexes, \{[\s\S]*?delisted: state\.delisted[\s\S]*?\}\)/);
  });

  test('change handler on the delisted select refreshes the filtered list', () => {
    expect(SRC).toContain("delistedEl.addEventListener('change', () => { state.delisted = delistedEl.value; refilter(); })");
  });
});
