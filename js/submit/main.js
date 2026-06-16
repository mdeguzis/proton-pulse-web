// Entry module for submit.html. Migrated from the page's inline script.
import { FAULT_KEYS_WEB } from '../shared/scoring.js?v=0dae1257';
import { populateSubmitForm, prefillSubmitFormFromMyHardware, submitReport } from '../shared/submit.js?v=09904778';
import { SupaAuth } from '../shared/config.js?v=f6f2c00a';

(async function() {
  const params = new URLSearchParams(window.location.search);
  const appId = params.get('app');
  const editReportId = params.get('edit') || null;
  const titleParam = params.get('title') || '';
  const isEdit = !!editReportId;
  // fromCloud=1 -> user is publishing a cloud-saved config that doesnt
  // have report responses yet. Prefill what the cloud config carries
  // (proton version, launch options, hardware) and the user fills in the
  // can-install/start/play/verdict/faults answers to turn it into a real
  // report. Save goes through the normal new-report path (writes to
  // user_configs with form_responses)
  const fromCloud = !isEdit && params.get('fromCloud') === '1';

  if (!appId) {
    document.getElementById('game-title').textContent = 'No app ID provided';
    document.getElementById('submit-form-content').innerHTML =
      '<div style="padding:24px;color:var(--muted)">Add ?app=APPID to the URL to submit a report.</div>';
    return;
  }

  const backLink = document.getElementById('back-link');
  backLink.href = `app.html#/app/${appId}`;

  let title = titleParam;
  if (!title) {
    // Resolve via search-index.json (single canonical list of [appId, title]
    // pairs). The previous attempt fetched data/{appId}/ which returns the
    // directory's auto-generated HTML listing, not JSON -- so title silently
    // fell through to "App {id}" for every submission.
    try {
      const searchUrl = /^localhost/.test(location.host)
        ? 'https://www.proton-pulse.com/search-index.json'
        : 'search-index.json';
      const resp = await fetch(searchUrl);
      if (resp.ok) {
        const index = await resp.json();
        const hit = Array.isArray(index) && index.find(row => String(row[0]) === String(appId));
        if (hit) title = hit[1] || '';
      }
    } catch {}
    if (!title) {
      // Last-ditch: per-app data file. Use latest.json (real path) rather
      // than the directory listing
      try {
        const dataUrl = /^localhost/.test(location.host)
          ? `https://www.proton-pulse.com/data/${appId}/latest.json`
          : `data/${appId}/latest.json`;
        const resp = await fetch(dataUrl);
        if (resp.ok) {
          const data = await resp.json();
          // latest.json is an array of reports; any of them carries the title
          title = (Array.isArray(data) && data[0]?.title) || data?.title || data?.name || '';
        }
      } catch {}
    }
    if (!title) title = `App ${appId}`;
  }

  const titlePrefix = isEdit ? 'Edit Report' : fromCloud ? 'Publish Report' : title;
  document.getElementById('game-title').textContent = isEdit
    ? `Edit Report: ${title}`
    : fromCloud ? `Publish Report: ${title}` : title;
  document.title = `${isEdit ? 'Edit' : fromCloud ? 'Publish' : 'Submit'} Report: ${title} — Proton Pulse`;
  document.querySelector('.eyebrow').textContent = isEdit
    ? 'Edit a Report'
    : fromCloud ? 'Publish a Report' : 'Submit a Report';

  // auth check. On localhost the Steam OAuth redirect is configured for the
  // production domain, so signing in locally just bounces back to prod -- you
  // can't actually finish auth in dev. Skip the gate when the host is local
  // so the form can be visually previewed and the question flow tested,
  // even though submission will still fail without a real session.
  const isLocalDev = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(location.hostname);
  const session = await SupaAuth.getSession();
  if (!session?.user && !isLocalDev) {
    document.getElementById('auth-gate').hidden = false;
    document.getElementById('submit-form-content').hidden = true;
    document.getElementById('login-btn')?.addEventListener('click', () => {
      window.location.href = SupaAuth.buildLoginPageUrl(window.location.href);
    });
    return;
  }
  if (isLocalDev && !session?.user) {
    console.warn('[submit] localhost dev mode: bypassing auth gate. Submission will not work without a real session.');
  }

  const el = document.querySelector('.main-inner');
  try {
    await populateSubmitForm(el);
  } catch (err) {
    console.error('[submit] populateSubmitForm failed:', err);
    document.getElementById('submit-form-content').innerHTML =
      `<div style="padding:24px;color:var(--red)">Failed to load form: ${err.message || err}</div>`;
    return;
  }

  // In edit mode, pre-fill from existing report; otherwise fall back to saved hardware
  if (isEdit && session) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${encodeURIComponent(editReportId)}&select=*&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
      );
      const rows = r.ok ? await r.json() : [];
      const rec = rows[0];
      if (rec) {
        const form = el.querySelector('#submit-report-form');
        const set = (name, val) => { if (form?.elements[name] && val != null) form.elements[name].value = val; };
        set('gameTitle',    rec.title);
        set('cpu',          rec.cpu);
        set('gpu',          rec.gpu);
        set('gpuDriver',    rec.gpu_driver);
        set('gpuVendor',    rec.gpu_vendor);
        set('ram',          rec.ram);
        set('kernel',       rec.kernel);
        set('protonVersion',rec.proton_version);
        set('notes',        rec.notes);
        set('launchOptions',rec.launch_options || rec.config_key);
        set('duration',     rec.duration);
        // parse OS field -- stored as "SteamOS 3.6" or similar
        if (rec.os) {
          const osParts = rec.os.split(' ');
          set('os', osParts[0]);
          if (osParts.length > 1) set('osVersion', osParts.slice(1).join(' '));
        }
        // restore form_responses into radio/checkbox state
        const fr = rec.form_responses || {};
        const state = form._formState || {};
        const setRadio = (name, val) => {
          if (!val) return;
          state[name] = val;
          const radio = form.querySelector(`input[name="${name}"][value="${val}"]`);
          if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
        };
        setRadio('canInstall', fr.canInstall);
        setRadio('canStart',   fr.canStart);
        setRadio('canPlay',    fr.canPlay);
        setRadio('verdict',    fr.verdict === 'no' ? null : fr.verdict);
        // fault questions
        const FAULT_KEYS = ['performanceFaults','graphicalFaults','windowingFaults','audioFaults',
          'inputFaults','stabilityFaults','saveGameFaults','significantBugs'];
        for (const k of FAULT_KEYS) {
          if (fr[k]) setRadio(k, fr[k]);
          if (fr[k + 'Notes']) set(k + 'Notes', fr[k + 'Notes']);
        }
        setRadio('onlineMultiplayer', fr.onlineMultiplayer);
        if (fr.onlineMultiplayerNotes) set('onlineMultiplayerNotes', fr.onlineMultiplayerNotes);
        setRadio('localMultiplayer',  fr.localMultiplayer);
        if (fr.localMultiplayerNotes) set('localMultiplayerNotes', fr.localMultiplayerNotes);
        setRadio('offlineCompat', fr.offlineCompat);
        setRadio('requiresFramegen',  fr.requiresFramegen);
        if (fr.framegenType) set('framegenType', fr.framegenType);
        if (fr.framegenNotes) set('framegenNotes', fr.framegenNotes);
        // tinkering checkboxes
        if (fr.tinkeringMethods?.length) {
          state.tinkeringMethods = new Set(fr.tinkeringMethods);
          for (const m of fr.tinkeringMethods) {
            const cb = form.querySelector(`input[name="tinkeringMethod"][value="${CSS.escape(m)}"]`);
            if (cb) cb.checked = true;
          }
        }
        form._formState = state;
        console.debug('[submit] edit mode: prefilled from report', { editReportId, appId });
      }
    } catch (err) {
      console.warn('[submit] edit prefill failed:', err);
    }
    // change submit button label
    const submitBtn = el.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Save Changes';
  } else if (fromCloud && session) {
    // Pull the user's cloud config for this app so the proton version
    // + launch options + any saved hardware/profile fields are already
    // filled in. The user still has to answer the question flow, but
    // they don't re-type the data the cloud already knows about
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/user_proton_configs?app_id=eq.${encodeURIComponent(appId)}&voter_id=eq.${encodeURIComponent(session.user.id)}&select=app_name,config,updated_at&order=updated_at.desc&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
      );
      const rows = r.ok ? await r.json() : [];
      const rec = rows[0];
      if (rec) {
        const cfg = rec.config || {};
        const form = el.querySelector('#submit-report-form');
        const set = (name, val) => { if (form?.elements[name] && val != null) form.elements[name].value = val; };
        if (rec.app_name) set('gameTitle', rec.app_name);
        if (cfg.protonVersion) set('protonVersion', cfg.protonVersion);
        if (cfg.launchOptions) set('launchOptions', cfg.launchOptions);
        // Some cloud configs carry hardware snapshots from when the user
        // saved them; pull those in if present so the user doesnt re-type
        if (cfg.hardware) {
          const hw = cfg.hardware;
          set('cpu', hw.cpu);
          set('gpu', hw.gpu);
          set('gpuDriver', hw.gpuDriver);
          set('gpuVendor', hw.gpuVendor);
          set('ram', hw.ram);
          set('kernel', hw.kernel);
          if (hw.os) {
            const osParts = String(hw.os).split(' ');
            set('os', osParts[0]);
            if (osParts.length > 1) set('osVersion', osParts.slice(1).join(' '));
          }
        }
        console.debug('[submit] fromCloud: prefilled from cloud config', { appId });
      } else {
        // No cloud config found (race condition / row missing) -- fall
        // back to saved-hardware prefill so the form isnt totally empty
        prefillSubmitFormFromMyHardware(el);
      }
    } catch (err) {
      console.warn('[submit] fromCloud prefill failed:', err);
      prefillSubmitFormFromMyHardware(el);
    }
    const submitBtn = el.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Publish';
  } else if (fromCloud && !session) {
    // localhost dev preview without auth: can't fetch cloud config, just
    // prefill from saved hardware so the form is at least populated
    prefillSubmitFormFromMyHardware(el);
    const submitBtn = el.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Publish (dev preview)';
  } else {
    prefillSubmitFormFromMyHardware(el);
  }

  const titleInput = el.querySelector('input[name="gameTitle"]');
  if (titleInput && !titleInput.value) titleInput.value = title;

  const form = el.querySelector('#submit-report-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const statusEl = el.querySelector('#submit-status');
      const submitBtn = form.querySelector('button[type="submit"]');
      const savingText = isEdit ? 'Saving...' : 'Submitting...';
      const savedText  = isEdit ? 'Saved! Redirecting...' : 'Report submitted! Redirecting...';

      el.querySelectorAll('.sf-question.sf-needs-answer').forEach(q => q.classList.remove('sf-needs-answer'));
      const state = form._formState || {};
      const needsAnswer = [];
      if (!state.canInstall) needsAnswer.push('q-canInstall');
      if (state.canInstall === 'yes' && !state.canStart) needsAnswer.push('q-canStart');
      if (state.canInstall === 'yes' && state.canStart === 'yes' && !state.canPlay) needsAnswer.push('q-canPlay');
      const allYes = state.canInstall === 'yes' && state.canStart === 'yes' && state.canPlay === 'yes';
      if (allYes && !state.verdict) needsAnswer.push('q-verdict');
      if (allYes) {
        for (const k of (typeof FAULT_KEYS_WEB !== 'undefined' ? FAULT_KEYS_WEB : [])) {
          if (!state.faults?.[k]) needsAnswer.push('q-' + k);
        }
      }
      for (const id of needsAnswer) {
        const q = el.querySelector('#' + id);
        if (q) q.classList.add('sf-needs-answer');
      }
      // Block submission if any required question is unanswered. The UI
      // already highlights the missing rows via .sf-needs-answer; bail
      // before the network call so users dont publish half-empty reports.
      // This is critical for the Publish-from-cloud flow where the form
      // arrives with hardware prefilled but every response is blank
      if (needsAnswer.length > 0) {
        const first = el.querySelector('#' + needsAnswer[0]);
        first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (statusEl) {
          statusEl.textContent = `Please answer ${needsAnswer.length} required question${needsAnswer.length === 1 ? '' : 's'} before publishing.`;
          statusEl.style.color = 'var(--red)';
        }
        return;
      }

      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = savingText; }
      if (statusEl) { statusEl.textContent = savingText; statusEl.style.color = 'var(--accent)'; }

      try {
        let result;
        if (isEdit) {
          result = await submitReport(appId, title, form, editReportId);
        } else {
          result = await submitReport(appId, title, form);
        }
        if (result.ok) {
          if (statusEl) { statusEl.textContent = savedText; statusEl.style.color = 'var(--green)'; }
          if (typeof window.ppTrack === 'function') window.ppTrack('report_submit', { app_id: String(appId), is_edit: isEdit });
          setTimeout(() => { window.location.href = `app.html#/app/${appId}`; }, 1200);
        } else {
          if (statusEl) { statusEl.textContent = result.error || 'Failed'; statusEl.style.color = 'var(--red)'; }
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? 'Save Changes' : 'Submit'; }
        }
      } catch (err) {
        console.error('[submit] save failed:', err);
        if (statusEl) { statusEl.textContent = err.message || 'Failed'; statusEl.style.color = 'var(--red)'; }
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? 'Save Changes' : 'Submit'; }
      }
    });
  }
})().catch(err => {
  console.error('[submit] page init failed:', err);
  const fc = document.getElementById('submit-form-content');
  if (fc) fc.innerHTML = `<div style="padding:24px;color:var(--red)">Page error: ${err.message || err}</div>`;
});
