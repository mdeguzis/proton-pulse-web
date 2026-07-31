(function () {
  var SUPABASE_URL = window.SUPABASE_URL;
  var SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

  function getSessionId() {
    var sid = sessionStorage.getItem('pp_sid');
    if (!sid) {
      sid = crypto.randomUUID();
      sessionStorage.setItem('pp_sid', sid);
    }
    return sid;
  }

  // #202: stable per-browser id for anonymous visitors. Uses the SAME
  // localStorage key that js/shared/submit.js::getWebClientId writes, so a
  // visitor's tracker events and their submitted reports/votes share the
  // same client_id. Without this, the analytics DB function counted
  // count(distinct coalesce(user_id, client_id)) but every anonymous row
  // had null for both and Unique visitors flatlined at the authed-user
  // count.
  function getWebClientId() {
    try {
      var key = 'proton-pulse:web-client-id';
      var id = localStorage.getItem(key);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(key, id);
      }
      return id;
    } catch (e) {
      // localStorage may throw in private-mode Safari; degrade to a
      // per-session random so we still contribute one distinct visitor.
      return getSessionId();
    }
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

  // #436: flag automated traffic so admin analytics can split humans from
  // bots. Client-side JS only ever sees the crawlers that execute scripts
  // (headless Chrome, scrapers, link-preview fetchers) -- most search-engine
  // crawlers never run this at all, so this is a floor on bot traffic, not a
  // full count. navigator.webdriver catches automation frameworks; the UA
  // regex catches the self-identifying bots. A missing UA is itself a signal.
  function classifyBot() {
    try { if (navigator && navigator.webdriver) return true; } catch (e) { /* ignore */ }
    var ua = (navigator && navigator.userAgent) || '';
    if (!ua) return true;
    return /bot\b|crawl|spider|slurp|mediapartners|bingpreview|facebookexternalhit|embedly|pinterest|redditbot|vkshare|w3c_validator|whatsapp|telegrambot|discordbot|slackbot|twitterbot|linkedinbot|applebot|googlebot|bingbot|yandex|baiduspider|duckduckbot|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|dataforseo|headlesschrome|phantomjs|puppeteer|playwright|lighthouse|gtmetrix|pagespeed|python-requests|curl\/|wget\/|axios\/|node-fetch|go-http-client|scrapy/i.test(ua);
  }
  var IS_BOT = classifyBot();

  // #436: derive the traffic source for a page_view. referrerSource returns
  // the referring host with same-origin navigation dropped (internal clicks
  // are not a traffic source) and the leading www. stripped so google.com and
  // www.google.com collapse. Only the host is kept -- never the full URL --
  // so we do not store query strings or paths from wherever the visitor came.
  function referrerSource() {
    try {
      var ref = (typeof document !== 'undefined' && document.referrer) || '';
      if (!ref) return '';
      var u = new URL(ref);
      if (u.host === (location && location.host)) return '';
      return u.host.replace(/^www\./, '');
    } catch (e) { return ''; }
  }

  // #436: campaign attribution from utm_* query params. Stored under short
  // keys (source/medium/campaign) and capped so a crafted link cannot bloat
  // the row. Absent params yield an empty object so the page_view stays clean.
  function utmParams() {
    var out = {};
    try {
      var p = new URLSearchParams((location && location.search) || '');
      ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) {
        var v = p.get(k);
        if (v) out[k.replace('utm_', '')] = String(v).slice(0, 80);
      });
    } catch (e) { /* ignore */ }
    return out;
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
    // #366: also push into the local ring buffer so the admin Logging tab
    // shows every ppTrack event live -- not just 'log' entries. Fires
    // BEFORE the network POST so a slow / failed fetch never blocks the
    // local visibility. Non-log events land at INFO level; explicit log
    // entries carry their own level in metadata.
    try {
      if (window.ppLogBuffer && typeof window.ppLogBuffer.pushLog === 'function') {
        var lvl = (eventType === 'log' && metadata && metadata.level) ? metadata.level : 'INFO';
        var msg = eventType === 'log' ? (metadata && metadata.msg) || '' : eventType;
        var ctx = eventType === 'log' ? (metadata && metadata.ctx) || {} : Object.assign({}, metadata || {});
        window.ppLogBuffer.pushLog(lvl, msg, Object.assign({ event_type: eventType, page: location.pathname }, ctx));
      }
    } catch (_) { /* buffer failure must never break analytics */ }
    var session = await getCurrentSession();
    var protonPulseUserId = session && session.user ? session.user.id : null;
    var accessToken = session && session.access_token ? session.access_token : null;
    // Always attach device + bot flag. If the caller passed metadata, fold it
    // in. #436: host lets admin_analytics exclude staging (staging.proton-
    // pulse.com) from prod counts even though its paths are clean; only added
    // when the environment exposes one so the tracker unit tests stay tidy.
    var meta = Object.assign({ device: DEVICE, bot: IS_BOT }, metadata || {});
    try { if (location && location.host) meta.host = location.host; } catch (e) { /* ignore */ }
    var payload = {
      event_type: eventType,
      page: location.pathname,
      session_id: getSessionId(),
      proton_pulse_user_id: protonPulseUserId,
      client_id: getWebClientId(),
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

  // #404: CSP violations fire securitypolicyviolation, NOT window.onerror,
  // so a misconfigured connect-src silently killed fetches with nothing in
  // the admin Logging panel. Capture them as WARN + a rate-limited
  // error_event. Reuses the error cooldown (signature = directive + URI) so
  // an extension injecting a blocked stylesheet on every page cannot flood
  // site_events.
  document.addEventListener('securitypolicyviolation', function (e) {
    if (!e) return;
    var payload = {
      message: 'CSP violation: ' + (e.violatedDirective || '?') + ' blocked ' + (e.blockedURI || '?'),
      violated_directive: e.violatedDirective || '',
      blocked_uri: (e.blockedURI || '').slice(0, 512),
      source_file: (e.sourceFile || '').slice(0, 512),
      line: e.lineNumber || 0,
      source: 'securitypolicyviolation',
    };
    try {
      if (window.ppLogBuffer && typeof window.ppLogBuffer.pushLog === 'function') {
        window.ppLogBuffer.pushLog('WARN', payload.message, {
          event_type: 'csp_violation',
          page: location.pathname,
          blocked_uri: payload.blocked_uri,
          violated_directive: payload.violated_directive,
          source_file: payload.source_file,
        });
      }
    } catch (_) { /* buffer failure must never break the listener */ }
    var sig = payload.violated_directive + '|' + payload.blocked_uri;
    var now = Date.now();
    if (_errorCooldown[sig] && (now - _errorCooldown[sig]) < ERROR_COOLDOWN_MS) return;
    _errorCooldown[sig] = now;
    track('error_event', payload);
  });

  document.addEventListener('DOMContentLoaded', function () {
    // #436: attach traffic source to the page_view so admin analytics can
    // answer "where did this visit come from". Empty fields are omitted so a
    // direct, campaign-less visit still posts a clean payload.
    var pv = {};
    var src = referrerSource();
    if (src) pv.referrer = src;
    var utm = utmParams();
    if (Object.keys(utm).length) pv.utm = utm;
    track('page_view', pv);

    document.querySelectorAll('a').forEach(function (a) {
      if (a.href && a.href.indexOf('steam-callback') !== -1) {
        a.addEventListener('click', function () {
          track('auth_attempt', {});
        });
      }
    });
  });
})();
