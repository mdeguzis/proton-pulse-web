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

  test('quicklinks include a "Where the data comes from" jump so readers find the source list', () => {
    expect(ABOUT).toMatch(/href="#data-sources"[^>]*>[^<]*Where the data comes from/);
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
});
