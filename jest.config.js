module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/*.test.js'],
  transform: {
    '^.+\\.m?js$': 'babel-jest',
  },
  // The site's import paths carry a ?v=<content-hash> cache-busting
  // suffix that Node cannot resolve. Strip it at module-resolution time
  // so babel-jest can transform + instrument these files for coverage.
  moduleNameMapper: {
    '^(.*?)\\?v=[a-f0-9]+$': '$1',
  },
  // Coverage scope: pure-ish modules with real branching logic. Page-init
  // IIFEs (js/admin/main.js, js/profile/main.js, etc.) and DOM-heavy
  // components stay out -- those need jsdom rather than a vm context to
  // measure cleanly, and the source-shape tests catch their regressions
  // already. As behavioral tests come in for component files, add them
  // here so the threshold below keeps applying.
  collectCoverageFrom: [
    'js/app/utils.js',
    'js/app/config.js',
    'js/app/lib/search-match.js',
    'js/app/api/deck-status.js',
    'js/admin/permissions.js',
    'js/admin/api/allReports.js',
    'js/admin/api/analytics.js',
    'js/admin/api/pending.js',
    'js/admin/api/depotTracking.js',
    'js/admin/api/pcgamingwiki-explore.js',
    'js/admin/lib/reportSource.js',
    'js/profile/utils.js',
    'js/lib/analytics.js',
    'js/lib/app-id.js',
    'js/lib/adult-filter.js',
    'js/lib/data-url.js',
    'js/lib/gpu-arch-detector.js',
    'js/lib/store-url-parser.js',
    'js/lib/user-prefs.js',
    'js/lib/scoring/gameStats.js',
    'js/shared/analytics-history.js',
    'js/shared/analytics-patterns.js',
    'js/shared/library-correlations.js',
    'js/shared/mangohud-csv.js',
    'js/shared/purpose-charts.js',
  ],
  // Thresholds ratchet: raise them when coverage rises, never lower them
  // to admit a regression. Current actuals (2026-07-25): 91.7 / 82.6 /
  // 92.1 / 93.6 -- thresholds sit ~2 pts under to absorb line-count noise
  // from refactors while still catching any real coverage drop.
  coverageThreshold: {
    global: {
      statements: 89,
      branches: 80,
      functions: 90,
      lines: 91,
    },
  },
};
