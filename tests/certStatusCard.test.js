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

describe('public status page renders the two-cert model + graph', () => {
  test('imports the two-cert + day-math helpers from cert.js', () => {
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

  test('edge cert drives the headline; origin + github_pages shown as context', () => {
    const start = STATUS_SRC.indexOf('function renderCertCard');
    const end = STATUS_SRC.indexOf('async function loadAndRenderCert');
    const cardFn = STATUS_SRC.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    // Headline state comes from the edge cert.
    expect(cardFn).toMatch(/certStateForCert\(edge\)/);
    // Origin cert and GitHub's ACME state both surface in the card.
    expect(cardFn).toMatch(/status\.origin/);
    expect(cardFn).toMatch(/github_pages/);
    // Burndown plots the edge cert's expiry field.
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
