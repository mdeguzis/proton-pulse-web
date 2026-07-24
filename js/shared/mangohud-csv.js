// mangohud-csv.js -- pure CSV parser for MangoHud logs. Extract min / avg /
// max FPS from an uploaded log file so users on any platform (not just
// Steam Deck) can drop a MangoHud CSV into the submit form and have the
// three FPS fields filled in for them.
//
// The parser is deliberately forgiving. MangoHud has shipped several
// slightly different CSV layouts over the years, and users occasionally
// paste files that also contain the leading system-info block. Rules:
//   1. Scan for the first header row that includes a token starting with
//      "fps" (case-insensitive). Column position may vary.
//   2. Ignore any row above that header, and any non-numeric row below.
//   3. Drop rows whose FPS parses as < 1 (paused / benchmark warm-up
//      artifacts) or > 1000 (garbage).
//   4. Round returned values to one decimal so they fit numeric(6,1).
//
// Returned shape: { fpsMin, fpsAvg, fpsMax, sampleCount, error? }.
// error is populated (with a short human message) when we could not
// find a usable FPS column or every row was filtered out.

const MIN_VALID_FPS = 1;      // sub-1 FPS is almost always a paused sample
const MAX_VALID_FPS = 1000;   // above this we assume junk / units mismatch

function _splitCsvLine(line) {
  // MangoHud logs are simple comma-separated numerics; no quoted fields
  // or escapes in the wild. Trim so trailing '\r' from Windows-authored
  // files does not corrupt the last column.
  return line.split(',').map(s => s.trim());
}

function _findFpsColumn(headerCells) {
  // Accept 'fps', 'FPS', 'fps_avg' as long as the token begins with fps.
  // Return the earliest match; MangoHud puts a bare 'fps' column first.
  for (let i = 0; i < headerCells.length; i++) {
    const c = headerCells[i].toLowerCase();
    if (c === 'fps' || c.startsWith('fps')) return i;
  }
  return -1;
}

/**
 * Parse the text contents of a MangoHud CSV log.
 *
 * @param {string} text  raw file contents
 * @returns {{ fpsMin: number|null, fpsAvg: number|null, fpsMax: number|null,
 *            sampleCount: number, error?: string }}
 */
export function parseMangohudCsv(text) {
  const empty = { fpsMin: null, fpsAvg: null, fpsMax: null, sampleCount: 0 };
  if (typeof text !== 'string' || text.trim() === '') {
    return { ...empty, error: 'Empty file.' };
  }

  const lines = text.split(/\r?\n/);
  let fpsCol = -1;
  let headerFound = false;
  const samples = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!headerFound) {
      const cells = _splitCsvLine(line);
      const idx = _findFpsColumn(cells);
      if (idx >= 0) {
        fpsCol = idx;
        headerFound = true;
      }
      continue;
    }
    const cells = _splitCsvLine(line);
    if (cells.length <= fpsCol) continue;
    const val = Number(cells[fpsCol]);
    if (!Number.isFinite(val)) continue;
    if (val < MIN_VALID_FPS || val > MAX_VALID_FPS) continue;
    samples.push(val);
  }

  if (!headerFound) {
    return { ...empty, error: 'No FPS column found in the CSV header.' };
  }
  if (samples.length === 0) {
    return { ...empty, error: 'No usable FPS samples in the CSV.' };
  }

  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of samples) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const round1 = (n) => Math.round(n * 10) / 10;
  return {
    fpsMin: round1(min),
    fpsAvg: round1(sum / samples.length),
    fpsMax: round1(max),
    sampleCount: samples.length,
  };
}
