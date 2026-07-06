/**
 * #197: the Daily activity chart must count anonymous sessions, not just
 * logged-in users. These grep-level assertions pin the wiring so a future
 * edit cannot silently revert the chart's green line to authed-only.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ANALYTICS_JS = read('js/admin/components/analytics.js');
const MIGRATION = read('supabase/migrations/20260705150000_analytics_count_anonymous_visitors.sql');

describe('analytics counts anonymous visitors via client_id (#197)', () => {
  test('chart data source is unique_visitors, with unique_users as legacy fallback', () => {
    // Must consume the new field first; falling back to unique_users only
    // when the API payload predates the migration.
    expect(ANALYTICS_JS).toMatch(/data: daily\.map\(r => r\.unique_visitors \?\? r\.unique_users \?\? 0\)/);
  });

  test('chart legend + caption drop the authenticated qualifier', () => {
    expect(ANALYTICS_JS).toContain('>Unique visitors</span>');
    expect(ANALYTICS_JS).not.toMatch(/distinct authenticated users per day/);
    expect(ANALYTICS_JS).toMatch(/counting both signed-in users and anonymous sessions/);
  });

  test('summary shows Unique visitors AND Logged in users as separate rows', () => {
    // Both numbers stay visible so admins can compare the total pool vs
    // the signed-in subset at a glance.
    expect(ANALYTICS_JS).toMatch(/label: 'Unique visitors'/);
    expect(ANALYTICS_JS).toMatch(/label: 'Logged in users'/);
    // The old Unique users label pointed at authed_users -- the visible
    // metric must not still carry that misleading combination.
    expect(ANALYTICS_JS).not.toMatch(/label: 'Unique users',\s*value: totals\.authed_users/);
  });

  test('migration coalesces proton_pulse_user_id with client_id', () => {
    expect(MIGRATION).toMatch(/count\(distinct coalesce\(proton_pulse_user_id::text, client_id\)\)/);
    // The daily rollup AND the totals block both need the new metric --
    // one without the other leaves either the chart or the summary stale.
    expect(MIGRATION).toMatch(/as\s+unique_visitors/);
    expect(MIGRATION).toMatch(/'unique_visitors',\s+count\(distinct coalesce/);
  });

  test('migration keeps authed_users so the Logged in users row still populates', () => {
    expect(MIGRATION).toMatch(/'authed_users',\s+count\(distinct proton_pulse_user_id\)/);
  });
});
