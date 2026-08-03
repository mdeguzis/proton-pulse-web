/**
 * #324: About page framing -- Proton Pulse is NOT just a ProtonDB frontend.
 *
 * Locks in the language change so a well-meaning copy edit does not
 * accidentally re-frame the site as "a ProtonDB frontend". The signal
 * researchers and press need is the "Where the data comes from" section
 * naming every ingest by name.
 */
const fs = require('fs');
const path = require('path');

const ABOUT = fs.readFileSync(path.join(__dirname, '..', 'about.html'), 'utf8');

describe('about.html framing (#324)', () => {
  test('opening paragraph leads with what Proton Pulse does, not with ProtonDB', () => {
    // The first paragraph after the h1 must NOT open with a ProtonDB
    // comparison. It should describe what the site is on its own terms.
    const opening = ABOUT.match(/<h1>About Proton Pulse<\/h1>\s*<p>([\s\S]*?)<\/p>/);
    expect(opening).toBeTruthy();
    const body = opening[1].trim();
    // Must not open with "a ProtonDB ..." -- that framing is what we are
    // pushing back on.
    expect(body).not.toMatch(/^Proton Pulse is (a|an)\s+[A-Za-z]+\s+for ProtonDB/i);
    // Must include concrete things we do beyond consuming ProtonDB.
    expect(body).toMatch(/report submission/i);
    expect(body).toMatch(/moderation/i);
    expect(body).toMatch(/(scoring|score)/i);
    expect(body).toMatch(/Steam Deck/i);
    // Must explicitly frame ProtonDB as one input among several.
    // Allow any whitespace (including newlines) between "one of" and "several"
    // since the HTML source may wrap the sentence across lines.
    expect(body).toMatch(/one of\s+several/i);
  });

  test('jump-to-section navigation reaches "Where the data comes from" so readers find the source list', () => {
    // #428: the six pill anchors were replaced by a Jump-to dropdown that
    // scrolls the picked section into view on change. Assert the option
    // is present in the select with the value matching the anchor id.
    expect(ABOUT).toMatch(/<option value="data-sources"[^>]*>\s*Where the data comes from\s*<\/option>/);
    // Section anchor still exists so the jump has something to land on.
    expect(ABOUT).toMatch(/id="data-sources"/);
  });

  test('jump-to select covers every top-level section on the page (#428)', () => {
    // Guard against a future section addition that forgets to add an
    // option to the dropdown, or a rename that breaks the anchor id.
    for (const [value, label] of [
      ['data-sources',  'Where the data comes from'],
      ['your-data',     'Your Data &amp; Privacy'],
      ['safety',        'Safety &amp; Security'],
      ['icons-signage', 'Icons &amp; Signage'],
      ['compare',       'Compare Proton Pulse'],
      ['mission',       'Mission'],
    ]) {
      const re = new RegExp(`<option value="${value}"[^>]*>\\s*${label}\\s*</option>`);
      expect(ABOUT).toMatch(re);
      // Every option must map to a real anchor id on the same page.
      expect(ABOUT).toMatch(new RegExp(`id="${value}"`));
    }
  });

  test('data-sources section exists and names every ingest', () => {
    const section = ABOUT.match(/id="data-sources"[\s\S]*?<div class="section-label"/);
    expect(section).toBeTruthy();
    const body = section[0];
    for (const label of [
      'ProtonDB reports',
      'Pulse Reports',
      'Steam Web API',
      'Deck / Machine / SteamOS verification',
      'GOG + Epic',
      'Hardware-weighted scoring',
    ]) {
      expect(body).toContain(label);
    }
  });

  test('ProtonDB card explicitly frames it as one input, not the whole site', () => {
    // Otherwise a reader can still walk away thinking we are a frontend.
    expect(ABOUT).toMatch(/One of several inputs, not the whole site/i);
  });

  test('the Proton Pulse vs ProtonDB comparison table remains reachable', () => {
    expect(ABOUT).toMatch(/id="compare"/);
    expect(ABOUT).toMatch(/Proton Pulse vs ProtonDB/);
  });

  test('icons legend documents the trend arrows with their card colors', () => {
    // The up/down trend triangle on cards needs a legend entry or users
    // have no idea what the little colored triangle means. Colors must
    // match card.js / cards.css: Steam Verified green up, Steam orange down.
    const legend = ABOUT.match(/id="icons-signage"[\s\S]*?<div class="section-label" id="compare"/);
    expect(legend).toBeTruthy();
    const body = legend[0];
    expect(body).toContain('Compatibility trend');
    expect(body).toContain('Trending up');
    expect(body).toContain('Trending down');
    // the actual triangle glyphs, colored to match the card
    expect(body).toContain('M6 1 L11 11 L1 11 Z" fill="#51ae40"');
    expect(body).toContain('M6 11 L11 1 L1 1 Z" fill="#e0652b"');
    // and the explanation names the 90-day comparison window
    expect(body).toMatch(/90 to 270 days/);
  });
});
