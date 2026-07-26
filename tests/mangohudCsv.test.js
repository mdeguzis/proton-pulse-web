/**
 * Tests for js/shared/mangohud-csv.js -- parseMangohudCsv.
 *
 * The parser is forgiving on purpose because MangoHud has shipped several
 * CSV layouts. These tests pin the invariants users depend on: the FPS
 * column is auto-detected, junk rows are filtered, and the min/avg/max
 * come back rounded to one decimal so they slot straight into the
 * numeric(6,1) DB columns.
 */

const { parseMangohudCsv } = require('../js/shared/mangohud-csv.js');

describe('parseMangohudCsv', () => {
  test('empty / non-string input returns an error', () => {
    expect(parseMangohudCsv('').error).toMatch(/empty/i);
    expect(parseMangohudCsv('   \n').error).toMatch(/empty/i);
    expect(parseMangohudCsv(null).error).toMatch(/empty/i);
    expect(parseMangohudCsv(undefined).error).toMatch(/empty/i);
  });

  test('no fps column in header -> reports the error, does not throw', () => {
    const csv = 'timestamp,cpu_load,gpu_load\n1,50,60\n';
    const out = parseMangohudCsv(csv);
    expect(out.error).toMatch(/no fps column/i);
    expect(out.fpsMin).toBeNull();
  });

  test('bare fps column: extracts min/avg/max rounded to 1 decimal', () => {
    const csv = [
      'fps,frametime',
      '60.0,16.7',
      '58.5,17.1',
      '61.2,16.3',
      '59.7,16.7',
    ].join('\n');
    const out = parseMangohudCsv(csv);
    expect(out.error).toBeUndefined();
    expect(out.sampleCount).toBe(4);
    expect(out.fpsMin).toBe(58.5);
    expect(out.fpsMax).toBe(61.2);
    // avg = (60 + 58.5 + 61.2 + 59.7) / 4 = 59.85 -> rounded to 1 dp = 59.9
    expect(out.fpsAvg).toBe(59.9);
  });

  test('emits percentile lows and a downsampled series (#410)', () => {
    // 1000 monotonically increasing samples: p1 lands near the low end,
    // and the series buckets down to exactly 120 points.
    const vals = Array.from({ length: 1000 }, (_, i) => (i + 1) / 10 + 1); // 1.1..101.0
    const csv = 'fps\n' + vals.join('\n');
    const out = parseMangohudCsv(csv);
    expect(out.error).toBeUndefined();
    expect(out.sampleCount).toBe(1000);
    expect(out.fpsP1).toBeGreaterThanOrEqual(out.fpsMin);
    expect(out.fpsP01).toBeLessThanOrEqual(out.fpsP1);
    expect(out.series).toHaveLength(120);
    // Bucket means preserve the trend: last point > first point.
    expect(out.series[119]).toBeGreaterThan(out.series[0]);
  });

  test('short logs keep the raw series (no padding)', () => {
    const out = parseMangohudCsv('fps\n60\n61\n62');
    expect(out.series).toEqual([60, 61, 62]);
  });

  test('picks the correct column when fps is not first', () => {
    const csv = [
      'frametime,cpu_load,fps',
      '16.7,50,60.0',
      '17.1,55,58.5',
    ].join('\n');
    const out = parseMangohudCsv(csv);
    expect(out.fpsMin).toBe(58.5);
    expect(out.fpsMax).toBe(60);
  });

  test('skips a system-info block above the runtime header', () => {
    // Some MangoHud logs prepend a hardware summary block. Everything up
    // to (and not including) the first fps-bearing header must be ignored.
    const csv = [
      'os,cpu,gpu,ram,vram',
      'Linux,AMD Ryzen 7,RX 7900 XT,32GB,20GB',
      '',
      'fps,frametime',
      '60,16.7',
      '62,16.1',
    ].join('\n');
    const out = parseMangohudCsv(csv);
    expect(out.error).toBeUndefined();
    expect(out.sampleCount).toBe(2);
    expect(out.fpsMin).toBe(60);
    expect(out.fpsMax).toBe(62);
  });

  test('drops junk rows: sub-1 FPS (paused samples) and > 1000 (garbage)', () => {
    const csv = [
      'fps,frametime',
      '60,16.7',
      '0.0,999',
      '0.5,999',
      '5000,0.2',
      '58,17.2',
    ].join('\n');
    const out = parseMangohudCsv(csv);
    expect(out.sampleCount).toBe(2);
    expect(out.fpsMin).toBe(58);
    expect(out.fpsMax).toBe(60);
  });

  test('every row filtered -> reports "no usable samples" error', () => {
    const csv = [
      'fps,frametime',
      '0,999',
      '5000,0.1',
    ].join('\n');
    const out = parseMangohudCsv(csv);
    expect(out.error).toMatch(/no usable/i);
    expect(out.fpsMin).toBeNull();
  });

  test('handles CRLF line endings (Windows-authored files)', () => {
    const csv = 'fps,frametime\r\n60,16.7\r\n58,17.2\r\n';
    const out = parseMangohudCsv(csv);
    expect(out.sampleCount).toBe(2);
    expect(out.fpsMin).toBe(58);
    expect(out.fpsMax).toBe(60);
  });

  test('tolerates blank lines interleaved with data', () => {
    const csv = [
      'fps,frametime',
      '',
      '60,16.7',
      '',
      '58,17.2',
      '',
    ].join('\n');
    const out = parseMangohudCsv(csv);
    expect(out.sampleCount).toBe(2);
  });

  test('accepts an fps_avg column when a bare fps is not present', () => {
    // Some newer MangoHud builds emit fps_avg, fps_min, fps_max instead
    // of a per-frame fps column. We accept the first fps-prefixed column.
    const csv = [
      'timestamp,fps_avg,fps_min,fps_max',
      '1,60,50,70',
      '2,62,52,72',
    ].join('\n');
    const out = parseMangohudCsv(csv);
    // fps_avg comes first among fps-prefixed columns -> use that.
    expect(out.sampleCount).toBe(2);
    expect(out.fpsMin).toBe(60);
    expect(out.fpsMax).toBe(62);
  });
});
