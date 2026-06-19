/**
 * @jest-environment jest-environment-jsdom
 */
const fs = require('fs');
const path = require('path');

beforeAll(() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'lib', 'toast.js'), 'utf8');
  window.eval(src); // toast.js is a classic IIFE that sets window.ppToast
});

describe('ppToast', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test('exposes window.ppToast with success/error/info helpers', () => {
    expect(typeof window.ppToast).toBe('function');
    expect(typeof window.ppToast.success).toBe('function');
    expect(typeof window.ppToast.error).toBe('function');
    expect(typeof window.ppToast.info).toBe('function');
  });

  test('renders a toast with the message and the type class', () => {
    window.ppToast.success('Saved');
    const t = document.querySelector('.pp-toast');
    expect(t).toBeTruthy();
    expect(t.classList.contains('pp-toast--success')).toBe(true);
    expect(t.querySelector('.pp-toast-msg').textContent).toBe('Saved');
  });

  test('error toasts announce via role=alert', () => {
    window.ppToast.error('Boom');
    expect(document.querySelector('.pp-toast--error').getAttribute('role')).toBe('alert');
  });

  test('the close button dismisses the toast', () => {
    window.ppToast('hi');
    const t = document.querySelector('.pp-toast');
    t.querySelector('.pp-toast-close').click();
    expect(t.classList.contains('pp-toast--out')).toBe(true);
  });

  test('multiple toasts stack inside one container', () => {
    window.ppToast('a');
    window.ppToast('b');
    expect(document.querySelectorAll('#pp-toast-container .pp-toast').length).toBe(2);
  });
});

describe('actions give feedback via ppToast', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  test('flag report toasts on success and failure', () => {
    const src = read('js/app/components/game-page.js');
    expect(src).toContain("window.ppToast?.success('Report flagged for review");
    expect(src).toContain('window.ppToast?.error(\'Could not flag the report');
  });

  test('submit report toasts on success and failure', () => {
    const src = read('js/submit/main.js');
    expect(src).toContain('window.ppToast?.success(');
    expect(src).toContain('window.ppToast?.error(');
  });

  test('admin moderation actions toast on success and failure', () => {
    const src = read('js/admin/main.js');
    expect(src).toContain('window.ppToast?.success(doneMsg)');
    expect(src).toContain('window.ppToast?.error(`Action failed');
    expect(src).toContain("window.ppToast?.success('Flag entry deleted.')");
  });

  test('vote failures surface a toast', () => {
    const src = read('js/app/api/votes.js');
    expect(src).toContain('window.ppToast?.error');
  });

  test('admin and profile actions use toasts, not alert()', () => {
    expect(read('js/admin/main.js')).not.toContain('alert(');
    expect(read('js/admin/components/userDetail.js')).not.toContain('alert(');
    expect(read('js/profile/main.js')).toContain('window.ppToast?.success(msg)');
    expect(read('js/auth/main.js')).toContain('window.ppToast?.error');
  });

  test('toast.js is in the gh-pages manifest', () => {
    expect(read('gh-pages-manifest.txt')).toContain('js/lib/toast.js');
  });
});
