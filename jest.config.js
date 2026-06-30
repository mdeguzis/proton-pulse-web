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
    'js/admin/permissions.js',
    'js/admin/api/allReports.js',
    'js/admin/api/analytics.js',
    'js/admin/api/pending.js',
    'js/profile/utils.js',
    'js/lib/analytics.js',
    'js/lib/app-id.js',
    'js/lib/gpu-arch-detector.js',
  ],
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 70,
      functions: 80,
      lines: 80,
    },
  },
};
