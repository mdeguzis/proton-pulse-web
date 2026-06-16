module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/*.test.js'],
  collectCoverageFrom: [
    'js/app/utils.cjs',
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
