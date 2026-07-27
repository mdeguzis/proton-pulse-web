// Guards the admin Logging tab "Refresh" button (#417). The Logging table is a
// snapshot of the in-memory ring buffer; when live-tail is off and no filter is
// active the tab deliberately does NOT redraw underneath the user. Refresh gives
// an explicit way to re-read the buffer and repaint. This test asserts the
// button is present and wired to re-render, so a future refactor can't silently
// drop it. Source-level assertion matches the pattern in filterPanelRegressions.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'components', 'logging.js'),
  'utf8',
);

describe('admin Logging tab Refresh button', () => {
  test('renders a Refresh button in the toolbar', () => {
    expect(src).toMatch(/id="admin-log-refresh"[^>]*>Refresh</);
  });

  test('the Refresh click handler re-reads modules and repaints the table', () => {
    // Grab the click handler body and confirm it calls both the module-options
    // refresh and the table render (i.e. a full repaint of the current buffer).
    const handler = src.match(
      /#admin-log-refresh'\)\.addEventListener\('click',\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/,
    );
    expect(handler).not.toBeNull();
    const body = handler[1];
    expect(body).toMatch(/_refreshModuleOptions\(host\)/);
    expect(body).toMatch(/_renderTable\(host\)/);
  });
});
