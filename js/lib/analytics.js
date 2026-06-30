(function () {
  var SUPABASE_URL = window.SUPABASE_URL;
  var SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

  function getSessionId() {
    var sid = sessionStorage.getItem('pp_sid');
    if (!sid) {
      sid = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('pp_sid', sid);
    }
    return sid;
  }

  // #143: classify the visitor's device so admin charts can break Deck vs
  // phone vs desktop without a separate column. UA sniffing is fine here --
  // we just want a rough bucket, not feature detection.
  function classifyDevice() {
    var ua = (navigator && navigator.userAgent) || '';
    if (ua.indexOf('SteamDeck') !== -1) return 'deck';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile';
    if (/Windows|Macintosh|Linux|X11/i.test(ua)) return 'desktop';
    return 'other';
  }
  var DEVICE = classifyDevice();

  // #142: the daily Unique users chart on admin/analytics counts distinct
  // proton_pulse_user_id from site_events. Until this patch, track() never
  // attached the id, so the chart effectively measured logouts per day. Now
  // we await the current Supabase session before posting and attach the
  // user id + access token when one exists. Anonymous visitors still post
  // through the anon key, just without a proton_pulse_user_id.
  async function getCurrentSession() {
    try {
      if (window.SupaAuth && typeof window.SupaAuth.getSession === 'function') {
        return await window.SupaAuth.getSession();
      }
    } catch (e) {
      // SupaAuth not ready or threw -- treat as anonymous tracking.
    }
    return null;
  }

  async function track(eventType, metadata) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
    var session = await getCurrentSession();
    var protonPulseUserId = session && session.user ? session.user.id : null;
    var accessToken = session && session.access_token ? session.access_token : null;
    // Always attach device. If the caller passed metadata, fold it in.
    var meta = Object.assign({ device: DEVICE }, metadata || {});
    var payload = {
      event_type: eventType,
      page: location.pathname,
      session_id: getSessionId(),
      proton_pulse_user_id: protonPulseUserId,
      metadata: meta,
    };
    fetch(SUPABASE_URL + '/rest/v1/site_events', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + (accessToken || SUPABASE_ANON_KEY),
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(payload),
    }).catch(function () {});
  }

  window.ppTrack = track;

  // #143: client-side error reporter. Posts an error_event for each
  // window.onerror or unhandledrejection, with a per-signature rate limit
  // so a tight loop cannot flood site_events. Signature = message + first
  // stack frame, cooldown 60s.
  var _errorCooldown = Object.create(null);
  var ERROR_COOLDOWN_MS = 60 * 1000;
  function maybeTrackError(payload) {
    var sig = (payload.message || '') + '|' + ((payload.stack || '').split('\n')[0] || '');
    var now = Date.now();
    if (_errorCooldown[sig] && (now - _errorCooldown[sig]) < ERROR_COOLDOWN_MS) return;
    _errorCooldown[sig] = now;
    track('error_event', payload);
  }
  window.addEventListener('error', function (e) {
    if (!e) return;
    maybeTrackError({
      message: e.message || '',
      file: e.filename || '',
      line: e.lineno || 0,
      col: e.colno || 0,
      stack: (e.error && e.error.stack ? String(e.error.stack) : '').slice(0, 2048),
    });
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (!e) return;
    var reason = e.reason;
    var message = reason && reason.message ? reason.message : String(reason);
    var stack = reason && reason.stack ? String(reason.stack) : '';
    maybeTrackError({
      message: message,
      file: '',
      line: 0,
      col: 0,
      stack: stack.slice(0, 2048),
      source: 'unhandledrejection',
    });
  });

  document.addEventListener('DOMContentLoaded', function () {
    track('page_view', {});

    document.querySelectorAll('a').forEach(function (a) {
      if (a.href && a.href.indexOf('steam-callback') !== -1) {
        a.addEventListener('click', function () {
          track('auth_attempt', {});
        });
      }
    });
  });
})();
