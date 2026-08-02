/**
 * #437: submit.html used to download the whole 11.8MB search-index.json blob
 * just to resolve one title and read the replaced_by column. It now goes
 * through the batch search API (getGamesByIds), keyed by Steam appid. Lock
 * the shape so a refactor can't silently re-introduce the blob download.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('submit resolves titles via the batch search API, not the blob (#437)', () => {
  const submitSrc = read('js/submit/main.js');

  test('imports the batch getGamesByIds helper', () => {
    expect(submitSrc).toMatch(/import \{ getGamesByIds \} from '\.\.\/app\/api\/search-games\.js/);
  });

  test('no longer fetches the search-index.json blob', () => {
    expect(submitSrc).not.toContain("'search-index.json'");
    expect(submitSrc).not.toContain("'https://www.proton-pulse.com/search-index.json'");
  });

  test('resolves the game row via getGamesByIds for numeric (Steam) appids only', () => {
    // Batch endpoint is keyed by Steam appid; non-Steam ids (gog:/epic:/
    // pgwiki:) skip the call and fall back to the title URL param + the
    // per-app latest.json lookup.
    expect(submitSrc).toContain('if (/^\\d+$/.test(String(appId)))');
    expect(submitSrc).toContain('await getGamesByIds([appId])');
    expect(submitSrc).toContain('byId.get(String(appId))');
  });

  test('replaced_by comes off the resolved row and its title is a second batch call', () => {
    expect(submitSrc).toContain('indexRow && indexRow.replacedBy');
    expect(submitSrc).toContain('await getGamesByIds([replacedBy])');
    expect(submitSrc).toContain("byId.get(replacedBy)?.title");
  });
});
