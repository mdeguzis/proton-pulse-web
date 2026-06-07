// Entry module for plugin-link.html. Migrated from plugin-link.js.
import { SupaAuth } from '../shared/config.js';

(function initPluginLinkPage() {
  const diagnosticsPanel = document.getElementById('link-diagnostics');
  const diagnosticsCopy = document.getElementById('link-diagnostics-copy');
  const diagnosticsLog = document.getElementById('link-diagnostics-log');

  function showDiagnostic(headline, details) {
    if (diagnosticsPanel) diagnosticsPanel.hidden = false;
    if (diagnosticsCopy) diagnosticsCopy.textContent = headline;
    if (diagnosticsLog) diagnosticsLog.textContent = details || '';
  }

  function formatErrorDetails(error) {
    if (!error) return 'Unknown error';
    if (error instanceof Error) {
      return [error.message, error.stack].filter(Boolean).join('\n\n');
    }
    return String(error);
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('error', (event) => {
      showDiagnostic(
        'A browser error interrupted the Decky linking page.',
        formatErrorDetails(event.error || event.message),
      );
    });

    window.addEventListener('unhandledrejection', (event) => {
      showDiagnostic(
        'A background promise failed on the Decky linking page.',
        formatErrorDetails(event.reason),
      );
    });
  }

  function pluginFunctionUrl(name) {
    return `${SUPABASE_URL}/functions/v1/${name}`;
  }

  async function callPluginLinkFunction(name, session, body) {
    const headers = await SupaAuth.authHeaders();
    if (session?.access_token) {
      headers.Authorization = `Bearer ${session.access_token}`;
    }
    const r = await fetch(pluginFunctionUrl(name), {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
    });
    const text = await r.text();
    const payload = text ? (() => { try { return JSON.parse(text); } catch { return { error: text }; } })() : {};
    if (!r.ok) throw new Error(payload.error || payload.message || `HTTP ${r.status}`);
    return payload;
  }

  function getPluginLinkCodeFromLocation(loc = window.location) {
    const searchCode = new URLSearchParams(loc.search || '').get('pluginLinkCode');
    if (searchCode) return searchCode.toUpperCase();

    const hash = String(loc.hash || '');
    const hashQueryIndex = hash.indexOf('?');
    if (hashQueryIndex === -1) return null;
    const hashQuery = hash.slice(hashQueryIndex + 1);
    const hashCode = new URLSearchParams(hashQuery).get('pluginLinkCode');
    return hashCode ? hashCode.toUpperCase() : null;
  }

  function buildCompanionLink(code, baseHref = window.location.href) {
    const url = new URL(baseHref);
    url.hash = '';
    url.searchParams.set('pluginLinkCode', code.toUpperCase());
    return url.toString();
  }

  window.PluginLinkPage = {
    getPluginLinkCodeFromLocation,
    buildCompanionLink,
  };

  const code = getPluginLinkCodeFromLocation();
  const codeDisplay = document.getElementById('link-code-display');
  const codeNote = document.getElementById('link-code-note');
  const statusCard = document.getElementById('link-status-card');
  const statusPill = document.getElementById('link-status-pill');
  const statusHeadline = document.getElementById('link-status-headline');
  const statusBody = document.getElementById('link-status-body');
  const loginBtn = document.getElementById('link-login-btn');
  const copyCodeBtn = document.getElementById('link-copy-code-btn');
  const copyUrlBtn = document.getElementById('link-copy-url-btn');
  const mobileUrl = document.getElementById('link-mobile-url');
  const profileBtn = document.getElementById('link-open-profile-btn');

  function setStatus(state, pill, headline, body) {
    if (statusCard) statusCard.dataset.state = state;
    if (statusPill) statusPill.textContent = pill;
    if (statusHeadline) statusHeadline.textContent = headline;
    if (statusBody) statusBody.textContent = body;
  }

  async function copyText(value, onSuccess, onFailure) {
    try {
      await navigator.clipboard?.writeText(value);
      onSuccess();
    } catch (_) {
      onFailure();
    }
  }

  if (codeDisplay) codeDisplay.textContent = code || '----';
  if (mobileUrl) mobileUrl.textContent = code ? buildCompanionLink(code) : 'Generate a Decky code to build a phone link.';
  if (profileBtn) profileBtn.href = 'profile.html';

  copyCodeBtn?.addEventListener('click', () => {
    if (!code) {
      setStatus('error', 'Missing code', 'No Decky link code is loaded.', 'Generate a new code in the plugin, then open this page again.');
      return;
    }
    void copyText(
      code,
      () => setStatus('pending', 'Copied', 'Decky code copied.', 'Paste it anywhere you need, or just sign in here to let Proton Pulse finish the link automatically.'),
      () => setStatus('error', 'Copy failed', 'Could not copy the code.', 'You can still read the code on screen and type it manually if needed.'),
    );
  });

  copyUrlBtn?.addEventListener('click', () => {
    if (!code) {
      setStatus('error', 'Missing code', 'No phone link is available yet.', 'Generate a new code in Decky first.');
      return;
    }
    const value = buildCompanionLink(code);
    void copyText(
      value,
      () => setStatus('pending', 'Copied', 'Phone link copied.', 'Open that URL on your phone, sign in there, and the Decky install will link to the same Proton Pulse account.'),
      () => setStatus('error', 'Copy failed', 'Could not copy the phone link.', 'You can still manually copy the URL shown on the screen.'),
    );
  });

  loginBtn?.addEventListener('click', () => {
    loginBtn.disabled = true;
    try {
      SupaAuth.loginWithSteam(window.location.href);
    } catch (error) {
      console.error('[plugin-link] login error:', error);
      loginBtn.disabled = false;
      setStatus('error', 'Login failed', 'Could not start Steam sign-in.', 'Please try again.');
      showDiagnostic('Steam sign-in could not be started from the linking page.', formatErrorDetails(error));
    }
  });

  if (!code) {
    if (codeNote) {
      codeNote.textContent = 'Open this page from the Decky plugin after generating a code, or paste a valid plugin-link URL here from another device.';
    }
    setStatus('error', 'Missing code', 'No Decky link code was found.', 'Generate a code in Decky and reopen this page so Proton Pulse knows which install to link.');
    loginBtn?.setAttribute('disabled', 'disabled');
    return;
  }

  if (codeNote) {
    codeNote.textContent = 'This is the Decky code Proton Pulse will use when you sign in on this page or on your phone.';
  }

  setStatus('pending', 'Ready', 'Your Decky code is loaded.', 'Sign in with Steam here and Proton Pulse will complete the link in the background.');

  (async () => {
    const session = await SupaAuth.getSession();
    if (!session?.user) return;

    setStatus('pending', 'Linking', 'Finishing your Decky link...', 'Proton Pulse is attaching this Decky install to your signed-in account now.');

    try {
      await callPluginLinkFunction('plugin-link-complete', session, { linkCode: code });
      setStatus('success', 'Linked', 'Decky is now linked to your Proton Pulse account.', 'You can go back to your Steam Deck plugin now, or open your profile to review linked installs.');
      if (profileBtn) profileBtn.href = 'profile.html#linked-plugins-section';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus('error', 'Link failed', 'Proton Pulse could not complete the Decky link.', message);
      showDiagnostic('The signed-in link completion step failed.', formatErrorDetails(error));
    }
  })();
})();
