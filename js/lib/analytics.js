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

  function track(eventType, metadata) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
    var payload = {
      event_type: eventType,
      page: location.pathname,
      session_id: getSessionId(),
      metadata: (metadata && Object.keys(metadata).length > 0) ? metadata : null,
    };
    fetch(SUPABASE_URL + '/rest/v1/site_events', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
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
