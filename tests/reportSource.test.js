/**
 * Pin the classifier + label formatter used by admin analytics AND the
 * all-reports listing. Signature detection, not source-string trust:
 * a row is only 'plugin' if it has a positive plugin signature
 * (installation_id set OR source starts with 'plugin'). This prevents
 * imported ProtonDB mirror rows and old web submits with source='user'
 * from being mislabeled as Deck-plugin submissions.
 */

const { classifyReportSource, formatReportSourceLabel } =
  require('../js/admin/lib/reportSource.js');

describe('classifyReportSource', () => {
  test('web-* buckets into web', () => {
    for (const v of ['web', 'web-linux', 'web-windows', 'web-macos', 'web-steamdeck', 'WEB-LINUX']) {
      expect(classifyReportSource({ source: v })).toBe('web');
    }
  });

  test('plugin-* prefix buckets into plugin (forward-looking prefix)', () => {
    for (const v of ['plugin', 'plugin-linux', 'plugin-windows', 'Plugin-Steamdeck']) {
      expect(classifyReportSource({ source: v })).toBe('plugin');
    }
  });

  test('installation_id present is a positive plugin signature (source string ignored)', () => {
    // The Deck plugin's submit path always sets installation_id. Any row
    // that carries one came from the plugin, whatever the source string.
    expect(classifyReportSource({ source: 'user',           installation_id: 'iid-abc' })).toBe('plugin');
    expect(classifyReportSource({ source: 'protondb',       installation_id: 'iid-abc' })).toBe('plugin');
    expect(classifyReportSource({ source: 'protondb-local', installation_id: 'iid-abc' })).toBe('plugin');
    expect(classifyReportSource({ source: 'anything-weird', installation_id: 'iid-abc' })).toBe('plugin');
  });

  test('source=user WITHOUT installation_id is NOT plugin (imported / legacy row)', () => {
    // Regression guard for the Half-Life 4: Gabe's Revenge case: an
    // imported row with source='user' and no plugin signature should
    // NOT be labelled 'plugin'. Bucket falls to 'other' because the
    // source string does not start with 'web' either.
    expect(classifyReportSource({ source: 'user' })).toBe('other');
    expect(classifyReportSource({ source: 'protondb' })).toBe('other');
    expect(classifyReportSource({ source: 'protondb-local' })).toBe('other');
    expect(classifyReportSource({ source: 'user', installation_id: null })).toBe('other');
    expect(classifyReportSource({ source: 'user', installation_id: '' })).toBe('other');
  });

  test('empty / null / undefined row falls to other', () => {
    expect(classifyReportSource(null)).toBe('other');
    expect(classifyReportSource(undefined)).toBe('other');
    expect(classifyReportSource({})).toBe('other');
    expect(classifyReportSource({ source: '' })).toBe('other');
    expect(classifyReportSource({ source: 'cli-import' })).toBe('other');
  });

  test('bare string is accepted for convenience but cannot short-circuit to plugin', () => {
    // Some callers pass just the source string. That is fine, but with
    // no row we cannot see installation_id, so the 'user' string alone
    // must NOT be classified as plugin.
    expect(classifyReportSource('web-linux')).toBe('web');
    expect(classifyReportSource('plugin')).toBe('plugin');
    expect(classifyReportSource('user')).toBe('other');
    expect(classifyReportSource('protondb')).toBe('other');
  });
});

describe('formatReportSourceLabel', () => {
  test('rows with a positive plugin signature render as bare "plugin"', () => {
    expect(formatReportSourceLabel({ source: 'user',           installation_id: 'iid' })).toBe('plugin');
    expect(formatReportSourceLabel({ source: 'protondb',       installation_id: 'iid' })).toBe('plugin');
    expect(formatReportSourceLabel({ source: 'protondb-local', installation_id: 'iid' })).toBe('plugin');
    expect(formatReportSourceLabel({ source: 'plugin' })).toBe('plugin');
    expect(formatReportSourceLabel({ source: 'plugin-linux' })).toBe('plugin');
  });

  test('web submissions render as-is', () => {
    expect(formatReportSourceLabel({ source: 'web' })).toBe('web');
    expect(formatReportSourceLabel({ source: 'web-linux' })).toBe('web-linux');
    expect(formatReportSourceLabel({ source: 'web-steamdeck' })).toBe('web-steamdeck');
  });

  test('source=user WITHOUT installation_id renders raw (no false "plugin" label)', () => {
    // The Half-Life 4: Gabe's Revenge case: keep the raw source string
    // visible so admins can see the actual value and investigate.
    expect(formatReportSourceLabel({ source: 'user' })).toBe('user');
    expect(formatReportSourceLabel({ source: 'protondb' })).toBe('protondb');
    expect(formatReportSourceLabel({ source: 'protondb-local' })).toBe('protondb-local');
  });

  test('unknown values render as-is', () => {
    expect(formatReportSourceLabel({ source: 'cli-import' })).toBe('cli-import');
    expect(formatReportSourceLabel({ source: 'mystery' })).toBe('mystery');
  });

  test('empty / null / undefined render as empty string', () => {
    expect(formatReportSourceLabel(null)).toBe('');
    expect(formatReportSourceLabel(undefined)).toBe('');
    expect(formatReportSourceLabel({})).toBe('');
    expect(formatReportSourceLabel({ source: '' })).toBe('');
    expect(formatReportSourceLabel({ source: '   ' })).toBe('');
  });
});
