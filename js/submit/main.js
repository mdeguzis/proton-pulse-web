// Entry module for submit.html. Migrated from the page's inline script.
import { FAULT_KEYS_WEB } from '../shared/scoring.js?v=1b8ae722';
import { applyDraftSnapshot, populateSubmitForm, prefillSubmitFormFromMyHardware, renderVerifiedOwnerStatus, setRunTypeNativeAvailable, submitReport } from '../shared/submit.js?v=339c68ea';
import { fetchLinuxNativeSupport } from '../app/api/deck-status.js?v=00344372';
import { deleteDraft, getDraft, snapshotFormData, upsertDraft } from '../shared/drafts.js?v=da9caf1e';
import { SupaAuth } from '../shared/config.js?v=f6f2c00a';
import { appIdToDir } from '../lib/app-id.js?v=18a73fb7';

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

  // Where to go after a successful save. Defaults to the game page, but the
  // profile page passes return=profile.html so an edit returns to where the
  // user came from. Sanitized to a same-origin relative .html path to avoid an
  // open-redirect: no protocol, no //, must end in .html.
  const returnRaw = params.get('return') || '';
  const returnTo = /^[a-z0-9._-]+\.html(?:[?#].*)?$/i.test(returnRaw) ? returnRaw : null;

  if (!appId) {
    document.getElementById('game-title').textContent = 'No app ID provided';
    document.getElementById('submit-form-content').innerHTML =
      '<div style="padding:24px;color:var(--muted)">Add ?app=APPID to the URL to submit a report.</div>';
    return;
  }

  const backLink = document.getElementById('back-link');
  backLink.href = `app.html#/app/${appId}`;

  let title = titleParam;
  // Search-index lookup: always run so we can also read column 10
  // (replaced_by) for the warning banner, not just fall back for missing
  // titles. Cached to a shared variable so the replaced_by check reuses it.
  let searchIndex = null;
  let indexHit = null;
  try {
    const searchUrl = /^localhost/.test(location.host)
      ? 'https://www.proton-pulse.com/search-index.json'
      : 'search-index.json';
    const resp = await fetch(searchUrl);
    if (resp.ok) {
      searchIndex = await resp.json();
      indexHit = Array.isArray(searchIndex) && searchIndex.find(row => String(row[0]) === String(appId));
      if (!title && indexHit) title = indexHit[1] || '';
    }
  } catch {}
  if (!title) {
    if (!title) {
      // Last-ditch: per-app data file. Use latest.json (real path) rather
      // than the directory listing
      try {
        const appDir = appIdToDir(appId);
        const dataUrl = /^localhost/.test(location.host)
          ? `https://www.proton-pulse.com/data/${appDir}/latest.json`
          : `data/${appDir}/latest.json`;
        const resp = await fetch(dataUrl);
        if (resp.ok) {
          const data = await resp.json();
          // latest.json is an array of reports; any of them carries the title
          title = (Array.isArray(data) && data[0]?.title) || data?.title || data?.name || '';
        }
      } catch {}
    }
    if (!title) {
      // Steam Store API fallback -- returns name for any app on Steam
      try {
        const steamResp = await fetch(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&filters=basic`);
        if (steamResp.ok) {
          const steamData = await steamResp.json();
          const appData = steamData?.[String(appId)];
          if (appData?.success && appData?.data?.name) title = appData.data.name;
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
  // Subtitle under the game name: storefront + app id so a reporter always
  // knows exactly which entry they're writing against, especially when a
  // title exists on multiple stores or after a replaced-by redirect (#199).
  const storeGuess = String(appId).startsWith('gog:')  ? 'GOG'
                     : String(appId).startsWith('epic:') ? 'Epic'
                     : 'Steam';
  const subtitleEl = document.getElementById('game-subtitle');
  if (subtitleEl) {
    subtitleEl.hidden = false;
    subtitleEl.textContent = `${storeGuess} \u00b7 App ${appId}`;
  }

  // Replaced-by warning banner: if this appid was superseded by a newer one
  // (search-index column 10, populated by game_images.py), tell the user their
  // report will land on an old build. Renders above the form so they see it
  // before answering anything. (#199 follow-up)
  const replacedBy = indexHit && indexHit[10] ? String(indexHit[10]) : '';
  if (replacedBy) {
    const replacedTitle = (searchIndex || []).find(row => String(row[0]) === replacedBy)?.[1] || `App ${replacedBy}`;
    const holder = document.querySelector('.main-inner');
    const formHost = document.getElementById('submit-form-content');
    if (holder && formHost) {
      const banner = document.createElement('div');
      banner.className = 'submit-replaced-warning';
      banner.innerHTML = `
        <strong>Heads up:</strong> This app was replaced.
        Steam now sells this title as
        <a class="submit-replaced-link" href="submit.html?app=${encodeURIComponent(replacedBy)}&title=${encodeURIComponent(replacedTitle)}">${escHtml(replacedTitle)}</a>.
        Old app id: <code>${escHtml(String(appId))}</code>, new app id: <code>${escHtml(replacedBy)}</code>.
        Submitting here files a report against the <em>original</em> build. If you're playing the current version,
        <a class="submit-replaced-link" href="submit.html?app=${encodeURIComponent(replacedBy)}&title=${encodeURIComponent(replacedTitle)}">submit against the new appid</a> instead.
      `;
      formHost.parentNode.insertBefore(banner, formHost);
    }
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  }

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
  // Show the Verified owner pill at the top of the form when the user's
  // cached Steam library confirms ownership (#199).
  void renderVerifiedOwnerStatus(el, appId);

  // Cross-check Steam appdetails: if the title has no native Linux build,
  // disable the "Native Linux" run type so users cannot submit an
  // impossible run_type. Non-blocking; the toggle stays enabled until
  // Steam answers so the form renders instantly.
  void (async () => {
    try {
      const hasLinuxNative = await fetchLinuxNativeSupport(appId);
      setRunTypeNativeAvailable(el, hasLinuxNative);
    } catch (e) { console.debug('[submit] linux native probe skipped:', e); }
  })();

  // Cloud draft restore + Save Draft button. Only offer for fresh submits
  // (edits reload from the report itself; fromCloud has its own path).
  if (!isEdit && !fromCloud && session) {
    try {
      const draft = await getDraft(session, appId);
      if (draft?.form_data) {
        const restoreEl = el.querySelector('#sf-draft-restore');
        const formEl = el.querySelector('#submit-report-form');
        if (restoreEl && formEl) {
          const ageMs = draft.updated_at ? Date.now() - new Date(draft.updated_at).getTime() : 0;
          const ageLabel = ageMs > 86400000
            ? `${Math.round(ageMs / 86400000)} day${Math.round(ageMs / 86400000) === 1 ? '' : 's'} ago`
            : ageMs > 3600000
              ? `${Math.round(ageMs / 3600000)} hour${Math.round(ageMs / 3600000) === 1 ? '' : 's'} ago`
              : ageMs > 60000
                ? `${Math.round(ageMs / 60000)} minute${Math.round(ageMs / 60000) === 1 ? '' : 's'} ago`
                : 'just now';
          restoreEl.hidden = false;
          restoreEl.innerHTML = `
            <div class="sf-draft-restore-body">
              You have a saved draft for this game (from ${ageLabel}).
              <button type="button" id="draft-restore-btn">Restore draft</button>
              <button type="button" id="draft-discard-btn">Discard</button>
            </div>`;
          restoreEl.querySelector('#draft-restore-btn')?.addEventListener('click', () => {
            applyDraftSnapshot(formEl, draft.form_data);
            restoreEl.hidden = true;
            window.ppToast?.success('Draft restored.');
          });
          restoreEl.querySelector('#draft-discard-btn')?.addEventListener('click', async () => {
            restoreEl.hidden = true;
            try { await deleteDraft(session, appId); window.ppToast?.success('Draft discarded.'); }
            catch (e) { console.warn('[submit] discard draft failed', e); }
          });
        }
      }
    } catch (err) {
      console.warn('[submit] draft restore lookup failed', err);
    }
  }

  const saveDraftBtn = el.querySelector('#save-draft-btn');
  if (saveDraftBtn && session) {
    saveDraftBtn.addEventListener('click', async () => {
      const formEl = el.querySelector('#submit-report-form');
      if (!formEl) return;
      const prevLabel = saveDraftBtn.textContent;
      saveDraftBtn.disabled = true;
      saveDraftBtn.textContent = 'Saving...';
      try {
        await upsertDraft(session, appId, snapshotFormData(formEl));
        window.ppToast?.success('Draft saved. You can finish it later on any signed-in device.');
      } catch (err) {
        window.ppToast?.error(`Failed to save draft: ${err.message || err}`);
      } finally {
        saveDraftBtn.disabled = false;
        saveDraftBtn.textContent = prevLabel;
      }
    });
  } else if (saveDraftBtn) {
    saveDraftBtn.hidden = true;
  }

  // #153: markdown editor is on site-wide now (no flag). Wrap the Notes
  // textarea with Write / Preview tabs and render the preview via
  // window.markdownit. Falls through silently if the CDN failed to load,
  // in which case the textarea keeps working as plain text.
  if (typeof window.markdownit === 'function') {
    enhanceNotesWithMarkdown(el);
  }

  // In edit mode, pre-fill from existing report; otherwise fall back to saved hardware
  if (isEdit && session) {
    // #144: warn before editing a currently-published report. Fetch the
    // approval row first so we know whether the report is live. If the
    // user cancels, bounce them back to where they came from instead of
    // prefilling the form (avoids them seeing a half-loaded edit they
    // didn't want to start).
    try {
      const preCheckRes = await fetch(
        `${SUPABASE_URL}/rest/v1/report_approvals?report_id=eq.${editReportId}&select=approval_hash&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
      );
      const preCheckRows = preCheckRes.ok ? await preCheckRes.json() : [];
      const isCurrentlyPublished = preCheckRows.length > 0;
      if (isCurrentlyPublished) {
        const proceed = window.confirm(
          'This report is currently published. Editing it puts it back into ' +
          'pending review until the daily pipeline re-approves it. Continue?'
        );
        if (!proceed) {
          const dest = returnTo || `app.html#/app/${appId}`;
          window.location.href = dest;
          return;
        }
      }
    } catch (err) {
      // Approval pre-check is best-effort. A network blip should not block
      // the edit flow; the form still loads and the inline banner below
      // will reflect the actual status once it does come back.
      console.warn('[submit] edit pre-check failed:', err);
    }

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
        set('gameTitle', (rec.title && !/^App \d+$/.test(rec.title)) ? rec.title : title);
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

        // Show approval status banner
        try {
          const approvalRes = await fetch(
            `${SUPABASE_URL}/rest/v1/report_approvals?report_id=eq.${editReportId}&select=approval_hash,approved_at,approved_by`,
            { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
          );
          const approvalRows = approvalRes.ok ? await approvalRes.json() : [];
          const approval = approvalRows[0];
          const banner = document.createElement('div');
          banner.className = 'submit-approval-banner';
          if (approval) {
            // #149: collapsed default state. Header line shows the badge +
            // report number; everything else lives behind a native
            // <details>/<summary> expander, one field per row so a long
            // md5 hash never has to fit on the same line as a date.
            banner.innerHTML = `
              <details class="submit-approval-banner-details">
                <summary class="submit-approval-banner-summary">
                  <span class="submit-approval-badge submit-approval-badge--approved">Approved</span>
                  <span class="submit-approval-banner-report">Report #${editReportId}</span>
                  <span class="submit-approval-banner-toggle">See all details</span>
                </summary>
                <div class="submit-approval-banner-field"><span class="submit-approval-banner-label">Approved</span> ${new Date(approval.approved_at).toLocaleDateString()}</div>
                <div class="submit-approval-banner-field"><span class="submit-approval-banner-label">By</span> ${approval.approved_by || 'Auto-Moderator'}</div>
                <div class="submit-approval-banner-field"><span class="submit-approval-banner-label">Hash</span> <code>${approval.approval_hash}</code></div>
              </details>`;
          } else {
            banner.innerHTML = `<span class="submit-approval-badge submit-approval-badge--pending">Pending Approval</span> Report #${editReportId} | This report is awaiting review. It will not appear publicly until approved. Reference this ID if you need to request a manual review.`;
          }
          const formContent = document.getElementById('submit-form-content');
          formContent?.insertBefore(banner, formContent.firstChild);
        } catch {}
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
    // filled in. The user still has to answer the question flow to
    // Publish, but they can Save at any point to update the draft.
    let cloudRec = null;
    try {
      const uid = encodeURIComponent(session.user.id);
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/user_proton_configs?app_id=eq.${encodeURIComponent(appId)}&or=(voter_id.eq.${uid},proton_pulse_user_id.eq.${uid})&select=app_name,config,updated_at&order=updated_at.desc&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
      );
      const rows = r.ok ? await r.json() : [];
      cloudRec = rows[0] ?? null;
      if (cloudRec) {
        const cfg = cloudRec.config || {};
        const form = el.querySelector('#submit-report-form');
        const set = (name, val) => { if (form?.elements[name] && val != null) form.elements[name].value = val; };
        if (cloudRec.app_name) set('gameTitle', cloudRec.app_name);
        if (cfg.protonVersion) set('protonVersion', cfg.protonVersion);
        if (cfg.launchOptions) set('launchOptions', cfg.launchOptions);
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
        prefillSubmitFormFromMyHardware(el);
      }
    } catch (err) {
      console.warn('[submit] fromCloud prefill failed:', err);
      prefillSubmitFormFromMyHardware(el);
    }
    const submitBtn = el.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Publish';

    // Save button: patches the cloud draft without requiring the full question flow
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.className = 'submit-report-btn';
    saveBtn.style.cssText = 'background:var(--s2);color:var(--text);border:1px solid var(--border);';
    if (submitBtn) submitBtn.insertAdjacentElement('beforebegin', saveBtn);
    saveBtn.addEventListener('click', async () => {
      const form = el.querySelector('#submit-report-form');
      const get = name => form?.elements[name]?.value?.trim() || '';
      const hw = { ...(cloudRec?.config?.hardware || {}) };
      for (const k of ['cpu','gpu','gpuDriver','gpuVendor','ram','kernel']) {
        const v = get(k); if (v) hw[k] = v; else delete hw[k];
      }
      const osVal = [get('os'), get('osVersion')].filter(Boolean).join(' ');
      if (osVal) hw.os = osVal; else delete hw.os;
      const newConfig = { ...(cloudRec?.config || {}), protonVersion: get('protonVersion'), launchOptions: get('launchOptions'), hardware: hw };
      const gameTitle = el.querySelector('input[name="gameTitle"]')?.value?.trim() || title;
      const statusEl = el.querySelector('#submit-status');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const rpcR = await fetch(
          `${SUPABASE_URL}/rest/v1/rpc/update_my_cloud_config`,
          {
            method: 'POST',
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_app_id: parseInt(appId, 10), p_app_name: gameTitle, p_config: newConfig }),
          }
        );
        if (!rpcR.ok) { const msg = await rpcR.text().catch(() => ''); throw new Error(`HTTP ${rpcR.status}${msg ? ': ' + msg : ''}`); }
        cloudRec = { ...cloudRec, app_name: gameTitle, config: newConfig };
        if (statusEl) { statusEl.textContent = 'Saved.'; statusEl.style.color = 'var(--green)'; }
        console.debug('[submit] fromCloud: saved draft', { appId });
      } catch (err) {
        if (statusEl) { statusEl.textContent = 'Save failed: ' + (err.message || err); statusEl.style.color = 'var(--red)'; }
        console.warn('[submit] fromCloud: save draft failed', { appId, error: String(err) });
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
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

      el.querySelectorAll('.sf-question.sf-needs-answer, .sf-row.sf-needs-answer').forEach(q => q.classList.remove('sf-needs-answer'));
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

      // Required hardware/setup fields -- highlight their parent .sf-row on empty
      const REQUIRED_FIELD_NAMES = ['protonVersion', 'gpu', 'gpuVendor', 'cpu', 'ram', 'os', 'notes'];
      for (const name of REQUIRED_FIELD_NAMES) {
        const input = form.elements[name];
        if (input && !input.value.trim()) {
          const row = input.closest('.sf-row');
          if (row) row.classList.add('sf-needs-answer');
        }
      }

      const errorEls = el.querySelectorAll('.sf-needs-answer');
      if (errorEls.length > 0) {
        errorEls[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (statusEl) {
          statusEl.textContent = 'Please fill in all required fields before publishing.';
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
          // Toast is the single success confirmation now; no duplicate inline text.
          window.ppToast?.success(isEdit ? 'Changes saved.' : 'Report submitted. Thanks!');
          if (typeof window.ppTrack === 'function') window.ppTrack('report_submit', { app_id: String(appId), is_edit: isEdit });
          // Clean up the cloud draft now that the report is in.
          if (!isEdit && !fromCloud && session) {
            void deleteDraft(session, appId).catch(() => {});
          }
          const dest = returnTo || `app.html#/app/${appId}`;
          setTimeout(() => { window.location.href = dest; }, 900);
        } else {
          if (statusEl) { statusEl.textContent = result.error || 'Failed'; statusEl.style.color = 'var(--red)'; }
          window.ppToast?.error(result.error || (isEdit ? 'Could not save changes.' : 'Could not submit the report.'));
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? 'Save Changes' : 'Submit'; }
        }
      } catch (err) {
        console.error('[submit] save failed:', err);
        if (statusEl) { statusEl.textContent = err.message || 'Failed'; statusEl.style.color = 'var(--red)'; }
        window.ppToast?.error(`Submit failed: ${err.message || err}`);
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? 'Save Changes' : 'Submit'; }
      }
    });
  }
})().catch(err => {
  console.error('[submit] page init failed:', err);
  const fc = document.getElementById('submit-form-content');
  if (fc) fc.innerHTML = `<div style="padding:24px;color:var(--red)">Page error: ${err.message || err}</div>`;
});

// #153 spike: wraps the Notes textarea (name="notes") with a Write /
// Preview tab pair. Preview renders via markdown-it. The textarea keeps
// its name so the existing submitReport payload logic is untouched --
// the raw markdown flows into user_configs.notes exactly like plain
// text does today.
function enhanceNotesWithMarkdown(rootEl) {
  const textarea = rootEl.querySelector('textarea[name="notes"]');
  if (!textarea || textarea.dataset.mdEnhanced === '1') return;
  textarea.dataset.mdEnhanced = '1';

  // html: false stops raw HTML from flowing through so the notes field
  // is not an XSS vector. linkify + breaks match how most chat / issue
  // renderers behave (Discord, GitHub Discussions).
  const md = window.markdownit({
    html: false,
    linkify: true,
    breaks: true,
    typographer: false,
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'md-editor';
  wrapper.innerHTML = `
    <div class="md-editor-tabs" role="tablist">
      <button type="button" class="md-editor-tab md-editor-tab--active" data-md-tab="write" role="tab" aria-selected="true">Write</button>
      <button type="button" class="md-editor-tab" data-md-tab="preview" role="tab" aria-selected="false">Preview</button>
      <span class="md-editor-hint">Markdown supported</span>
    </div>
    <div class="md-editor-preview" hidden></div>
  `;
  textarea.parentNode.insertBefore(wrapper, textarea);
  wrapper.appendChild(textarea);

  const previewEl = wrapper.querySelector('.md-editor-preview');
  const writeBtn = wrapper.querySelector('[data-md-tab="write"]');
  const previewBtn = wrapper.querySelector('[data-md-tab="preview"]');

  function activate(tab) {
    const isPreview = tab === 'preview';
    writeBtn.classList.toggle('md-editor-tab--active', !isPreview);
    previewBtn.classList.toggle('md-editor-tab--active', isPreview);
    writeBtn.setAttribute('aria-selected', String(!isPreview));
    previewBtn.setAttribute('aria-selected', String(isPreview));
    textarea.hidden = isPreview;
    previewEl.hidden = !isPreview;
    if (isPreview) {
      const raw = textarea.value || '';
      previewEl.innerHTML = raw.trim()
        ? md.render(raw)
        : '<em class="md-editor-empty">Nothing to preview yet.</em>';
    }
  }
  writeBtn.addEventListener('click', () => activate('write'));
  previewBtn.addEventListener('click', () => activate('preview'));
}
