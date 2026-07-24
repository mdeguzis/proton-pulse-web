/**
 * toast.js -- tiny shared feedback toasts for the web app.
 *
 * Loaded as a classic script on every page (after topbar.js), so both the ES
 * module pages and the plain-script pages can call it the same way:
 *
 *   window.ppToast('Report submitted', { type: 'success' });
 *   window.ppToast.success('Saved');
 *   window.ppToast.error('Could not save -- try again');
 *
 * Toasts stack bottom-right, auto-dismiss, and can be closed manually. Errors
 * stay up longer and use role="alert" so screen readers announce them.
 */
(function () {
  const DEFAULT_TIMEOUT = 3500;
  const ERROR_TIMEOUT = 6000;

  function ensureContainer() {
    let c = document.getElementById('pp-toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'pp-toast-container';
      c.className = 'pp-toast-container';
      c.setAttribute('aria-live', 'polite');
      document.body.appendChild(c);
    }
    return c;
  }

  function dismiss(el) {
    if (!el || el._ppDismissed) return;
    el._ppDismissed = true;
    clearTimeout(el._ppTimer);
    el.classList.remove('pp-toast--in');
    el.classList.add('pp-toast--out');
    setTimeout(() => el.remove(), 250);
  }

  function ppToast(message, opts) {
    opts = opts || {};
    const type = opts.type || 'info'; // 'success' | 'error' | 'info'
    const timeout = opts.timeout != null ? opts.timeout : (type === 'error' ? ERROR_TIMEOUT : DEFAULT_TIMEOUT);
    const container = ensureContainer();

    const el = document.createElement('div');
    el.className = `pp-toast pp-toast--${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const msg = document.createElement('span');
    msg.className = 'pp-toast-msg';
    msg.textContent = String(message == null ? '' : message);
    el.appendChild(msg);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pp-toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '&times;';
    close.addEventListener('click', () => dismiss(el));
    el.appendChild(close);

    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('pp-toast--in'));
    el._ppTimer = setTimeout(() => dismiss(el), timeout);
    return el;
  }

  ppToast.success = (m, o) => ppToast(m, Object.assign({}, o, { type: 'success' }));
  ppToast.error = (m, o) => ppToast(m, Object.assign({}, o, { type: 'error' }));
  ppToast.info = (m, o) => ppToast(m, Object.assign({}, o, { type: 'info' }));

  window.ppToast = ppToast;
})();
