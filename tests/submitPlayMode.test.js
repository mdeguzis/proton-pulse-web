/**
 * Play Mode fields on the submit payload (#246).
 *
 * The rule that matters: vr_runtime / vr_device are ONLY ever populated for a
 * VR report, and are explicitly null (not omitted) otherwise. An edit that
 * switches VR back to Flatscreen has to clear the old values -- a PATCH that
 * omits a key leaves the column untouched, so the report would keep claiming
 * a headset it was no longer played on.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { normalizePlayMode, normalizeVrRuntime } = require('../js/shared/vr.js');

// submit.js is a browser ES module with side-effectful imports; lift just the
// helper under test, same approach as the other submit tests.
function loadVrFieldsFromForm() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js/shared/submit.js'), 'utf8');
  const start = src.indexOf('export function vrFieldsFromForm');
  const end = src.indexOf('// lightweight sysinfo parser');
  const slice = src.slice(start, end).replace(/^export\s+function\s/gm, 'function ');
  const sandbox = { normalizePlayMode, normalizeVrRuntime, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(slice + '\nmodule.exports = vrFieldsFromForm;', sandbox);
  return sandbox.module.exports;
}

const vrFieldsFromForm = loadVrFieldsFromForm();

// Minimal stand-in for the form element collection: named fields expose
// `.value`, matching how the real code reads form.vrRuntime.value.
function makeForm({ playMode, vrRuntime, vrDevice, vrDeviceOther } = {}) {
  return {
    playMode: playMode === undefined ? undefined : { value: playMode },
    vrRuntime: vrRuntime === undefined ? undefined : { value: vrRuntime },
    vrDevice: vrDevice === undefined ? undefined : { value: vrDevice },
    vrDeviceOther: vrDeviceOther === undefined ? undefined : { value: vrDeviceOther },
  };
}

describe('vrFieldsFromForm', () => {
  test('a flatscreen report nulls both VR columns', () => {
    expect(vrFieldsFromForm(makeForm({ playMode: 'flat' })))
      .toEqual({ play_mode: 'flat', vr_runtime: null, vr_device: null });
  });

  test('a flatscreen report nulls VR fields even when they carry stale values', () => {
    // The reveal handler clears them on toggle, but the payload must not rely
    // on the DOM having been cleaned up.
    const form = makeForm({ playMode: 'flat', vrRuntime: 'steamvr', vrDevice: 'Valve Index' });
    expect(vrFieldsFromForm(form))
      .toEqual({ play_mode: 'flat', vr_runtime: null, vr_device: null });
  });

  test('a VR report carries the runtime and headset', () => {
    const form = makeForm({ playMode: 'vr', vrRuntime: 'wivrn', vrDevice: 'Meta Quest 3' });
    expect(vrFieldsFromForm(form))
      .toEqual({ play_mode: 'vr', vr_runtime: 'wivrn', vr_device: 'Meta Quest 3' });
  });

  test('the Other headset sentinel resolves to the free-text value', () => {
    const form = makeForm({ playMode: 'vr', vrRuntime: 'monado', vrDevice: '__other', vrDeviceOther: 'Somniumvr1' });
    expect(vrFieldsFromForm(form).vr_device).toBe('Somniumvr1');
  });

  test('the Other sentinel never leaks into the payload when the box is empty', () => {
    const form = makeForm({ playMode: 'vr', vrRuntime: 'monado', vrDevice: '__other', vrDeviceOther: '   ' });
    expect(vrFieldsFromForm(form).vr_device).toBeNull();
  });

  test('headset is trimmed and capped to the DB length limit', () => {
    // user_configs_vr_device_chk caps at 64 chars; a longer value would fail
    // the insert rather than be truncated server-side.
    const form = makeForm({ playMode: 'vr', vrRuntime: 'steamvr', vrDevice: '__other', vrDeviceOther: '  ' + 'x'.repeat(100) + '  ' });
    expect(vrFieldsFromForm(form).vr_device).toHaveLength(64);
  });

  test('headset is optional on a VR report', () => {
    const form = makeForm({ playMode: 'vr', vrRuntime: 'alvr', vrDevice: '' });
    expect(vrFieldsFromForm(form))
      .toEqual({ play_mode: 'vr', vr_runtime: 'alvr', vr_device: null });
  });

  test('an unrecognized runtime is nulled rather than written raw', () => {
    const form = makeForm({ playMode: 'vr', vrRuntime: 'not a runtime!', vrDevice: '' });
    expect(vrFieldsFromForm(form).vr_runtime).toBeNull();
  });

  test('a missing play mode leaves everything null rather than assuming flat', () => {
    expect(vrFieldsFromForm(makeForm({})))
      .toEqual({ play_mode: null, vr_runtime: null, vr_device: null });
  });

  test('reads the checked radio when the form exposes querySelector instead', () => {
    // populateSubmitForm renders radios; a RadioNodeList exposes .value, but
    // the DOM-query path is the fallback for detached/stubbed forms.
    const form = {
      querySelector: (sel) => (sel === 'input[name="playMode"]:checked' ? { value: 'vr' } : null),
      vrRuntime: { value: 'steamvr' },
      vrDevice: { value: 'Valve Index' },
    };
    expect(vrFieldsFromForm(form))
      .toEqual({ play_mode: 'vr', vr_runtime: 'steamvr', vr_device: 'Valve Index' });
  });

  test('survives a null form without throwing', () => {
    expect(vrFieldsFromForm(null))
      .toEqual({ play_mode: null, vr_runtime: null, vr_device: null });
  });
});

describe('submit form markup', () => {
  const submitSrc = fs.readFileSync(path.join(__dirname, '..', 'js/shared/submit.js'), 'utf8');

  test('renders the Play Mode radios with no hardcoded default', () => {
    // The default now depends on the game: VR-only preselects VR, non-VR
    // preselects Flatscreen, and playable-both is left blank on purpose.
    expect(submitSrc).toContain('name="playMode" value="flat"');
    expect(submitSrc).toContain('name="playMode" value="vr"');
    expect(submitSrc).not.toContain('value="flat" checked');
  });

  test('VR rows start hidden and are wired to the toggle', () => {
    expect(submitSrc).toContain('id="sf-vr-runtime-row" hidden');
    expect(submitSrc).toContain('id="sf-vr-device-row" hidden');
    expect(submitSrc).toContain('wirePlayModeToggle(container)');
  });

  test('the payload includes the VR columns', () => {
    expect(submitSrc).toContain('...vrFieldsFromForm(form)');
  });
});

describe('applyPlayModeDefault (#246)', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');

  function loadHelper() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js/shared/submit.js'), 'utf8');
    const start = src.indexOf('export function applyPlayModeDefault');
    const end = src.indexOf('function wirePlayModeToggle');
    const slice = src.slice(start, end).replace(/^export\s+function\s/gm, 'function ');
    const sandbox = { Event, module: { exports: {} } };
    vm.createContext(sandbox);
    vm.runInContext(slice + '\nmodule.exports = applyPlayModeDefault;', sandbox);
    return sandbox.module.exports;
  }
  const applyPlayModeDefault = loadHelper();

  function makeContainer() {
    const radios = ['flat', 'vr'].map((value) => ({
      value, checked: false, required: false, events: [],
      dispatchEvent(e) { this.events.push(e.type); return true; },
    }));
    return {
      radios,
      querySelectorAll: () => radios,
    };
  }

  test('VR-only games preselect VR', () => {
    const c = makeContainer();
    expect(applyPlayModeDefault(c, 'only')).toBe('vr');
    expect(c.radios.find((r) => r.value === 'vr').checked).toBe(true);
    expect(c.radios.find((r) => r.value === 'flat').checked).toBe(false);
  });

  test('non-VR games preselect Flatscreen', () => {
    const c = makeContainer();
    expect(applyPlayModeDefault(c, null)).toBe('flat');
    expect(c.radios.find((r) => r.value === 'flat').checked).toBe(true);
  });

  test('games playable both ways are left blank and become required', () => {
    // A preselected answer here is one the reporter never consciously made,
    // and play mode changes what "runs well" even means.
    const c = makeContainer();
    expect(applyPlayModeDefault(c, 'supported')).toBeNull();
    expect(c.radios.some((r) => r.checked)).toBe(false);
    expect(c.radios.every((r) => r.required)).toBe(true);
  });

  test('a preselected mode is not left required', () => {
    const c = makeContainer();
    applyPlayModeDefault(c, 'only');
    expect(c.radios.every((r) => r.required === false)).toBe(true);
  });

  test('preselecting VR fires change so the runtime rows reveal', () => {
    // Setting .checked programmatically does not fire change, so the VR
    // runtime + headset rows would stay hidden on a VR-only game.
    const c = makeContainer();
    applyPlayModeDefault(c, 'only');
    expect(c.radios.find((r) => r.value === 'vr').events).toContain('change');
  });

  test('the blank case fires no change event', () => {
    const c = makeContainer();
    applyPlayModeDefault(c, 'supported');
    expect(c.radios.flatMap((r) => r.events)).toEqual([]);
  });

  test('survives a missing container or radios', () => {
    expect(applyPlayModeDefault(null, 'only')).toBeNull();
    expect(applyPlayModeDefault({ querySelectorAll: () => [] }, 'only')).toBeNull();
  });

  test('the markup no longer hardcodes a checked default', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js/shared/submit.js'), 'utf8');
    expect(src).not.toContain('name="playMode" value="flat" checked');
  });
});
