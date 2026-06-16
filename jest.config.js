module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/*.test.js'],
  transform: {
    '^.+\\.m?js$': 'babel-jest',
  },
  collectCoverageFrom: [
    'js/app/utils.js',
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
