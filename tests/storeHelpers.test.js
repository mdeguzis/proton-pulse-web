/**
 * Tests for the non-Steam store helpers in js/app/config.js and the GOG/Epic
 * routing in js/app/router.js. Catalog (non-Steam) games carry a prefixed
 * canonical id (gog:<productId>, epic:<namespace>); Steam ids are bare digits.
 */

// config.js reads window.location at module load, so stub it before requiring.
global.window = global;
global.location = {
  pathname: '/',
  hostname: 'localhost',
  origin: 'http://localhost',
  hash: '',
  search: '',
};
global.window.location = global.location;

const { appTypeFromAppId, storeLabel, storeLabelFromAppId } = require('../js/app/config.js');

describe('appTypeFromAppId', () => {
  test('detects gog and epic prefixes', () => {
    expect(appTypeFromAppId('gog:1207659014')).toBe('gog');
    expect(appTypeFromAppId('epic:fortnite-namespace')).toBe('epic');
  });
  test('bare digits and unknown ids fall back to steam', () => {
    expect(appTypeFromAppId('6020')).toBe('steam');
    expect(appTypeFromAppId(220)).toBe('steam');
    expect(appTypeFromAppId('')).toBe('steam');
  });
});

describe('storeLabel / storeLabelFromAppId', () => {
  test('maps app types to human labels', () => {
    expect(storeLabel('gog')).toBe('GOG');
    expect(storeLabel('epic')).toBe('Epic');
    expect(storeLabel('steam')).toBe('Steam');
    expect(storeLabel('mystery')).toBe('Steam'); // unknown falls back
  });
  test('derives the label straight from a canonical id', () => {
    expect(storeLabelFromAppId('gog:123')).toBe('GOG');
    expect(storeLabelFromAppId('epic:abc')).toBe('Epic');
    expect(storeLabelFromAppId('6020')).toBe('Steam');
  });
});

describe('getRoute parses GOG/Epic app ids', () => {
  const { loadEsm } = require('./_esm-vm.js');

  function routeFor(hash, search = '') {
    const ctx = loadEsm(['js/app/router.js'], {
      location: { hash, search },
      URLSearchParams,
    });
    return ctx.getRoute();
  }

  test('routes numeric Steam ids to the app page', () => {
    expect(routeFor('#/app/6020')).toMatchObject({ page: 'app', appId: '6020' });
  });
  test('routes gog: prefixed ids to the app page', () => {
    expect(routeFor('#/app/gog:1207659014')).toMatchObject({ page: 'app', appId: 'gog:1207659014' });
  });
  test('routes epic: prefixed ids to the app page', () => {
    expect(routeFor('#/app/epic:swat4ns')).toMatchObject({ page: 'app', appId: 'epic:swat4ns' });
  });
  test('decodes a percent-encoded colon in the id', () => {
    expect(routeFor('#/app/gog%3A1207659014')).toMatchObject({ page: 'app', appId: 'gog:1207659014' });
  });
  test('falls back to home with no hash and no query', () => {
    expect(routeFor('')).toMatchObject({ page: 'home' });
  });
});
