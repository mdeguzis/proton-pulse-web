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
    var payload = {
      event_type: eventType,
      page: location.pathname,
      session_id: getSessionId(),
      proton_pulse_user_id: protonPulseUserId,
      metadata: (metadata && Object.keys(metadata).length > 0) ? metadata : null,
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
