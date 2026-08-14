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

  test('renders the Play Mode radios with flatscreen preselected', () => {
    expect(submitSrc).toContain('name="playMode" value="flat" checked');
    expect(submitSrc).toContain('name="playMode" value="vr"');
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
