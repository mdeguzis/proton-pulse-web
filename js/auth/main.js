// Entry module for auth.html. Migrated from auth.js.
import { SupaAuth } from '../shared/config.js?v=f6f2c00a';

(function initAuthInterstitial() {
  const continueBtn = document.getElementById('continue-login-btn');
  const cancelLink = document.getElementById('cancel-login-link');
  const backLink = document.getElementById('auth-back-link');
  const params = new URLSearchParams(window.location.search);
  const returnToRaw = params.get('returnTo');
  const fallbackUrl = new URL('index.html', window.location.href).toString();

  let returnTo = fallbackUrl;

  if (returnToRaw) {
    try {
      const parsed = new URL(returnToRaw, window.location.href);
      if (parsed.origin === window.location.origin) {
        returnTo = parsed.toString();
      }
    } catch (_) {
      returnTo = fallbackUrl;
    }
  }

  if (cancelLink) {
    cancelLink.href = returnTo;
  }

  if (backLink) {
    backLink.href = returnTo;
  }

  continueBtn?.addEventListener('click', () => {
    continueBtn.disabled = true;
    continueBtn.classList.add('is-loading');

    try {
      SupaAuth.loginWithSteam(returnTo);
    } catch (error) {
      console.error('[auth] login error:', error);
      continueBtn.disabled = false;
      continueBtn.classList.remove('is-loading');
      window.alert('Could not start Steam sign-in. Please try again.');
    }
  });
})();
