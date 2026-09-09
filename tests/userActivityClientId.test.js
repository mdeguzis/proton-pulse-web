/**
 * #34: fetchUserActivity only ever queried site_events by userId, so an
 * anonymous user (client_id only, no proton_pulse_user_id) always rendered
 * a confident "Activity (0)" in the admin user detail screen regardless of
 * how much activity they actually had recorded.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UD_API   = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'api', 'userDetail.js'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'main.js'), 'utf8');

function activityBlock() {
  const start = UD_API.indexOf('export async function fetchUserActivity');
  expect(start).toBeGreaterThan(-1);
  return UD_API.slice(start, UD_API.indexOf('export async function', start + 10) === -1
    ? UD_API.length
    : UD_API.indexOf('export async function', start + 10));
}

describe('fetchUserActivity accepts clientId (#34)', () => {
  test('signature accepts clientId alongside userId', () => {
    expect(UD_API).toContain('export async function fetchUserActivity(session, { userId, clientId })');
  });

  test('falls back to client_id=eq. when userId is absent, mirroring fetchUserReports', () => {
    const block = activityBlock();
    expect(block).toContain("filter = `proton_pulse_user_id=eq.${encodeURIComponent(userId)}`");
    expect(block).toContain("filter = `client_id=eq.${encodeURIComponent(clientId)}`");
    expect(block).toContain('${SUPABASE_URL}/rest/v1/site_events?${filter}&select=${select}');
  });

  test('raises rather than silently returning [] when both ids are missing', () => {
    const block = activityBlock();
    expect(block).not.toMatch(/if \(!userId\) return \[\];?/);
    expect(block).toMatch(/throw new Error\(['"]fetchUserActivity requires a userId or clientId['"]\)/);
  });

  test('debug log carries clientId + the resolved filter for diagnosability', () => {
    const block = activityBlock();
    expect(block).toMatch(/console\.debug\(['"]\[userDetail\] fetchUserActivity['"],\s*\{[^}]*clientId[^}]*filter/);
  });
});

describe('main.js threads clientId through to fetchUserActivity (#34)', () => {
  test('the loadUserDetail call site passes user.client_id', () => {
    expect(MAIN_SRC).toContain(
      'fetchUserActivity(currentSession, { userId: uid, clientId: user.client_id || null })'
    );
  });
});

describe('site_events client_id index (#34)', () => {
  test('migration adds an index on (client_id, created_at desc)', () => {
    const sql = fs.readFileSync(
      path.join(ROOT, 'supabase', 'migrations', '20260909000000_add_site_events_client_id_index.sql'),
      'utf8'
    );
    expect(sql).toContain('create index if not exists site_events_client_created_at_idx');
    expect(sql).toContain('on public.site_events (client_id, created_at desc)');
  });
});
