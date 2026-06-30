/**
 * Tests for #48: capture a free-text reason when flagging or hiding a
 * report, propagate it through the PATCH body, surface it in the All
 * Reports row tooltip + the report detail panel.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN_SRC      = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'main.js'), 'utf8');
const ALLREPS_CMP   = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'components', 'allReports.js'), 'utf8');
const ALLREPS_API   = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'api', 'allReports.js'), 'utf8');

describe('promptFlagReason helper (#48)', () => {
  test('is defined in admin main module', () => {
    expect(MAIN_SRC).toContain('function promptFlagReason(action)');
  });

  test('uses window.prompt to capture the reason', () => {
    const block = MAIN_SRC.slice(
      MAIN_SRC.indexOf('function promptFlagReason'),
      MAIN_SRC.indexOf('function promptFlagReason') + 800
    );
    expect(block).toContain('window.prompt');
  });

  test('returns null on cancel (raw === null)', () => {
    const block = MAIN_SRC.slice(
      MAIN_SRC.indexOf('function promptFlagReason'),
      MAIN_SRC.indexOf('function promptFlagReason') + 800
    );
    expect(block).toContain('if (raw === null) return null');
  });

  test('treats confirmed empty string as cancelled (no blank reasons saved)', () => {
    const block = MAIN_SRC.slice(
      MAIN_SRC.indexOf('function promptFlagReason'),
      MAIN_SRC.indexOf('function promptFlagReason') + 800
    );
    expect(block).toMatch(/trim\(\)[\s\S]{0,80}if \(!trimmed\) return null/);
  });

  test('caps reason length at 200 chars', () => {
    const block = MAIN_SRC.slice(
      MAIN_SRC.indexOf('function promptFlagReason'),
      MAIN_SRC.indexOf('function promptFlagReason') + 800
    );
    expect(block).toContain('slice(0, 200)');
  });
});

describe('ar-flag / ar-hide call sites include reason in PATCH (#48)', () => {
  test('ar-flag PATCH carries is_flagged + flagged_reason + flagged_at', () => {
    // Walk both call sites: the detail panel onAction and the delegated
    // tbody handler. Both must include the reason fields.
    const flagBlocks = MAIN_SRC.match(/if \(action === 'ar-flag'\)[\s\S]{0,800}/g) || [];
    expect(flagBlocks.length).toBeGreaterThanOrEqual(2);
    for (const blk of flagBlocks) {
      expect(blk).toContain('is_flagged: true');
      expect(blk).toContain('flagged_reason: reason');
      expect(blk).toContain('flagged_at: new Date().toISOString()');
    }
  });

  test('ar-hide PATCH carries is_flagged + is_hidden + flagged_reason + flagged_at', () => {
    const hideBlocks = MAIN_SRC.match(/if \(action === 'ar-hide'\)[\s\S]{0,800}/g) || [];
    expect(hideBlocks.length).toBeGreaterThanOrEqual(2);
    for (const blk of hideBlocks) {
      expect(blk).toContain('is_flagged: true');
      expect(blk).toContain('is_hidden: true');
      expect(blk).toContain('flagged_reason: reason');
      expect(blk).toContain('flagged_at: new Date().toISOString()');
    }
  });

  test('ar-release PATCH clears flagged_reason + flagged_at to null', () => {
    const relBlocks = MAIN_SRC.match(/if \(action === 'ar-release'\)[\s\S]{0,500}/g) || [];
    expect(relBlocks.length).toBeGreaterThanOrEqual(2);
    for (const blk of relBlocks) {
      expect(blk).toContain('is_flagged: false');
      expect(blk).toContain('is_hidden: false');
      expect(blk).toContain('flagged_reason: null');
      expect(blk).toContain('flagged_at: null');
    }
  });

  test('cancelled prompt does not fire a PATCH (return early)', () => {
    // Each flag/hide branch must short-circuit on null reason BEFORE
    // calling patchReportFlags.
    const block = MAIN_SRC.slice(MAIN_SRC.indexOf("if (action === 'ar-flag')"));
    expect(block).toMatch(/promptFlagReason[\s\S]{0,200}if \(reason === null\)/);
  });
});

describe('All Reports table surfaces the reason (#48)', () => {
  test('statusBadges accepts and renders flaggedReason as title attribute', () => {
    expect(ALLREPS_CMP).toContain('function statusBadges(isF, isH, isP, flaggedReason)');
    expect(ALLREPS_CMP).toContain('title="${escapeHtml(String(flaggedReason))}"');
  });

  test('row template passes flagged_reason through to statusBadges + stashes on dataset', () => {
    expect(ALLREPS_CMP).toContain('statusBadges(r.is_flagged, r.is_hidden, r.is_pending, r.flagged_reason)');
    expect(ALLREPS_CMP).toContain('data-flagged-reason="${escapeHtml(String(r.flagged_reason))}"');
  });

  test('updateAllReportsRow accepts a flaggedReason arg and respects existing dataset on undefined', () => {
    // The signature picked up a 5th param (isPending) when #146 landed; this
    // test only cares about the flagged_reason handling and dataset fallback.
    expect(ALLREPS_CMP).toContain('updateAllReportsRow(id, isF, isH, flaggedReason, isPending)');
    expect(ALLREPS_CMP).toContain("flaggedReason !== undefined");
    expect(ALLREPS_CMP).toContain('row.dataset.flaggedReason');
  });

  test('updateAllReportsRow on release clears the dataset entry', () => {
    expect(ALLREPS_CMP).toContain('delete row.dataset.flaggedReason');
  });
});

describe('Report detail shows flagged_reason + flagged_at (#48)', () => {
  test('detail field list includes Flagged Reason + Flagged At', () => {
    expect(ALLREPS_CMP).toContain("['Flagged Reason',  val(report.flagged_reason)]");
    expect(ALLREPS_CMP).toContain("['Flagged At'");
  });
});

describe('API column lists include the new fields (#48)', () => {
  test('row COLS select includes flagged_reason', () => {
    expect(ALLREPS_API).toMatch(/const COLS = '[^']*flagged_reason[^']*'/);
  });

  test('DETAIL_COLS select includes flagged_reason + flagged_at', () => {
    expect(ALLREPS_API).toMatch(/const DETAIL_COLS = '[^']*flagged_reason[^']*flagged_at[^']*'/);
  });
});
