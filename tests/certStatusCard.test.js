/**
 * The certificate's validity window is public (anyone can read the served
 * cert), so the full detail and the burndown graph live on the public status
 * page rather than behind an admin gate (#359). This pins that: the status
 * page renders the graph and the day/date detail, and the admin panel no longer
 * carries a cert-only Infrastructure tab.
 */

const fs = require('fs');
const path = require('path');

const STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'status', 'main.js'),
  'utf8',
);

describe('public status page renders the single-cert model + graph', () => {
  // Post-#362 the site is fully served from Cloudflare Pages so there is only
  // one cert to track (the CF-served, browser-facing one). The old two-cert
  // model (edge + GitHub-Pages origin + GH ACME state) is gone.
  test('imports the day-math helpers from cert.js', () => {
    const imp = STATUS_SRC.match(/import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\.\/lib\/cert\.js/);
    expect(imp).not.toBeNull();
    const names = imp[1];
    expect(names).toMatch(/certStateForCert/);
    expect(names).toMatch(/daysRemaining/);
    expect(names).toMatch(/totalDays/);
    expect(names).toMatch(/daysBetween/);
  });

  test('renders the burndown graph on the status page', () => {
    expect(STATUS_SRC).toMatch(/function renderCertBurndown/);
    expect(STATUS_SRC).toMatch(/status-graph-svg/);
  });

  test('single-cert model: edge cert drives everything, no origin/github_pages', () => {
    const start = STATUS_SRC.indexOf('function renderCertCard');
    const end = STATUS_SRC.indexOf('async function loadAndRenderCert');
    const cardFn = STATUS_SRC.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    // Headline state comes from the edge cert.
    expect(cardFn).toMatch(/certStateForCert\(edge\)/);
    // Regression guard: the old two-cert fields must NOT appear on the card.
    // If they come back it means someone re-introduced the GH-Pages-behind-
    // Cloudflare cert probe -- which does not exist post-#362 and would be a
    // silent regression to a "GitHub Pages origin" line that has no meaning.
    expect(cardFn).not.toMatch(/status\.origin/);
    expect(cardFn).not.toMatch(/github_pages/);
    expect(cardFn).not.toMatch(/GitHub Pages origin/);
    // Burndown still plots the edge cert's expiry field.
    expect(cardFn).toMatch(/renderCertBurndown\(history, 'edge_not_after'\)/);
  });

  test('loads cert history alongside the status snapshot', () => {
    expect(STATUS_SRC).toMatch(/cert-history\.json/);
  });
});

describe('admin panel no longer has a cert-only Infrastructure tab', () => {
  test('infrastructure component file is removed', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'js', 'admin', 'components', 'infrastructure.js'))).toBe(false);
  });

  test('admin main.js does not reference the infrastructure tab', () => {
    const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'main.js'), 'utf8');
    expect(ADMIN_SRC).not.toMatch(/renderInfrastructure/);
  });
});
