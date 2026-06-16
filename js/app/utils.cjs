// CJS shim for Jest coverage instrumentation.
// Strips ESM export keywords from utils.js and evaluates the source so Istanbul
// can instrument the function bodies. The browser always uses utils.js directly
// (which is a proper ES module); this shim is only loaded by the test suite.
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf8')
  // Strip export declarations, leaving the function/const bodies intact
  .replace(/^export\s+(async\s+)?(function|const|let|var|class)\s/gm, '$1$2 ')
  // Drop the hybrid CJS export block at the bottom (would cause a redeclare)
  .replace(/\/\/ CJS hybrid export[\s\S]*$/, '');

// Stub browser globals that a few functions reference
const document = {
  createElement: (tag) => {
    const el = { textContent: '', innerHTML: '' };
    Object.defineProperty(el, 'textContent', {
      set(val) {
        this.innerHTML = String(val || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      },
    });
    return el;
  },
};
const window = { setTimeout };

// Evaluate the stripped source. The 'return' at the end lets us capture all
// top-level declarations as a plain object so we can re-export them below.
// eslint-disable-next-line no-new-func
const factory = new Function('document', 'window', 'URL', src + '\nreturn { normalizeOs, latestPerApp, withTimeout, latestPerClient, fmtDuration, fmtMinutes, reportKey, daysAgo, utcStamp, confColor, confTextColor, truncate, esc, cfgNa, downloadJson, configKey, hashReportKey, NA_SPAN };');

module.exports = factory(document, window, typeof URL !== 'undefined' ? URL : {});
