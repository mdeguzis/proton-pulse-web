// Entry module for confidence.html. Migrated from the page's inline script.
import { estimateScoreBreakdown, loadScoringInfo } from '../shared/scoring.js?v=0dae1257';
import { isPreviewHardware, loadMyHardware, renderPreviewHardwareBanner } from '../shared/hardware.js?v=6a1246aa';
import { attachChartHover } from '../shared/chart-interactions.js?v=6b608095';
import { appIdToDir } from '../lib/app-id.js?v=18a73fb7';

(function () {
  const root = document.getElementById('cb-root');
  const metaEl = document.getElementById('cb-meta');

  // CDN base - same fallback rule as app.js so the breakdown page works
  // on localhost dev preview without local data
  const SITE_BASE = (() => {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'proton-pulse-web' ? '/proton-pulse-web' : '';
  })();
  const IS_LOCAL_DEV = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname);
  const _usesProdData = IS_LOCAL_DEV || (location.hostname || '').endsWith('.github.io');
  const CDN_BASE = _usesProdData
    ? 'https://www.proton-pulse.com/data'
    : `${location.origin}${SITE_BASE}/data`;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  }

  // loadMyHardware lives in app-hardware.js so all pages share the same
  // localStorage keys + Steam Deck preview fallback. Always returns an
  // object now (preview vs saved is signalled by hw._isPreview).

  // Compute hardware match multipliers between the viewer's saved hw and a report.
  // w = weights object from scoring-info.json.
  function computeHwFactors(myHw, report, w, osFamilies) {
    const factors = [];

    // GPU vendor match
    const myVendor  = (myHw.gpuVendor || '').toLowerCase();
    const repVendor = (report.gpuVendor || '').toLowerCase();
    if (myVendor && repVendor) {
      const match = myVendor === repVendor;
      const mult = match ? w.GPU_MATCH : w.GPU_MISMATCH;
      factors.push({
        label: 'GPU vendor match',
        detail: `Your ${myHw.gpuVendor || 'unknown'} vs report ${report.gpuVendor || 'unknown'}`,
        multiplier: mult,
        matched: match,
        note: match ? 'Same GPU vendor -- report is more likely to reflect your experience.' : 'Different GPU vendor -- report may behave differently on your hardware.',
      });
    } else {
      factors.push({
        label: 'GPU vendor match',
        detail: `Your ${myHw.gpuVendor || 'unknown'} vs report ${report.gpuVendor || 'unknown'}`,
        multiplier: w.GPU_UNKNOWN,
        matched: null,
        note: 'GPU vendor unknown for one or both sides -- using neutral weight.',
      });
    }

    // OS family match
    if (myHw.os && report.os) {
      const myOsLow  = myHw.os.toLowerCase();
      const repOsLow = (report.os || '').toLowerCase();
      const exact    = myOsLow === repOsLow;
      let familyMatch = false;
      if (!exact && osFamilies) {
        for (const kids of Object.values(osFamilies)) {
          const kl = kids.map(k => k.toLowerCase());
          if (kl.some(k => myOsLow.includes(k)) && kl.some(k => repOsLow.includes(k))) {
            familyMatch = true; break;
          }
        }
      }
      const mult = exact ? w.OS_EXACT : (familyMatch ? w.OS_FAMILY_MATCH : 1.0);
      factors.push({
        label: 'OS match',
        detail: `Your ${myHw.os} vs report ${report.os}`,
        multiplier: mult,
        matched: exact || familyMatch,
        note: exact ? 'Exact OS match -- maximum relevance.' : familyMatch ? 'Same OS family -- partial match.' : 'Different OS -- report may have different environment quirks.',
      });
    }

    // Kernel match (parse major.minor)
    if (myHw.kernel && report.kernel) {
      const parseVer = v => (v || '').split('.').map(Number).filter(n => !isNaN(n));
      const mv = parseVer(myHw.kernel);
      const rv = parseVer(report.kernel);
      let mult = 1.0, matchLabel = 'no match';
      if (mv[0] === rv[0] && mv[1] === rv[1] && mv[2] === rv[2]) { mult = w.KERNEL_EXACT; matchLabel = 'exact'; }
      else if (mv[0] === rv[0] && mv[1] === rv[1]) { mult = w.KERNEL_PATCH_CLOSE; matchLabel = 'same minor'; }
      else if (mv[0] === rv[0]) { mult = w.KERNEL_MINOR_CLOSE; matchLabel = 'same major'; }
      factors.push({
        label: 'Kernel match',
        detail: `Your ${myHw.kernel} vs report ${report.kernel} (${matchLabel})`,
        multiplier: mult,
        matched: mult > 1.0,
        note: `Kernel ${matchLabel} -- ${mult > 1.0 ? 'closer kernel versions improve report relevance' : 'different kernel major -- environment may differ significantly'}.`,
      });
    }

    return factors;
  }

  // Apply hw factors to a base score and return the adjusted total.
  function applyHwFactors(baseScore, hwFactors) {
    return hwFactors.reduce((s, f) => s * f.multiplier, baseScore);
  }

  function valueClass(v) {
    return v > 0 ? 'cb-positive' : v < 0 ? 'cb-negative' : 'cb-neutral';
  }
  function valuePrefix(v) { return v > 0 ? '+' : ''; }

  function confColorAt(pct) {
    const s = pct / 10;
    if (s >= 8) return '#66c0f4';
    if (s >= 6) return '#4a90b8';
    if (s >= 4) return '#3a6680';
    return '#4a5a6a';
  }
  function confTextAt(pct) { return pct >= 70 ? '#0a1a24' : '#e8f4ff'; }

  const RATING_BASE = { platinum: 60, gold: 48, silver: 36, bronze: 24, borked: 0 };
  const RATING_COLORS = { platinum: '#b4c7dc', gold: '#c8a050', silver: '#8fa0b0', bronze: '#b07040', borked: '#c85050' };
  const RATING_TEXT_COLOR = { platinum: '#111', gold: '#111', silver: '#111', bronze: '#fff', borked: '#fff' };

  // Show the yes/no form answers that determined the rating. This connects
  // the chain: form answers -> rating -> confidence baseline so users see
  // the full derivation, not just the middle step
  const FAULT_KEYS = [
    'performanceFaults', 'graphicalFaults', 'windowingFaults', 'audioFaults',
    'inputFaults', 'stabilityFaults', 'saveGameFaults', 'significantBugs',
  ];
  const FAULT_LABELS = {
    performanceFaults: 'Performance issues',
    graphicalFaults:   'Graphical glitches',
    windowingFaults:   'Windowing issues',
    audioFaults:       'Audio issues',
    inputFaults:       'Input/controller issues',
    stabilityFaults:   'Crashes/instability',
    saveGameFaults:    'Save game issues',
    significantBugs:   'Significant bugs',
  };

  function ynBadge(val) {
    if (val === 'yes') return '<span style="display:inline-block;padding:1px 8px;border-radius:3px;background:#5ba32b;color:#0a0c10;font-size:0.74rem;font-weight:700">Yes</span>';
    if (val === 'no')  return '<span style="display:inline-block;padding:1px 8px;border-radius:3px;background:#c85050;color:#fff;font-size:0.74rem;font-weight:700">No</span>';
    return '<span style="display:inline-block;padding:1px 8px;border-radius:3px;background:var(--s2);color:var(--muted);font-size:0.74rem;font-weight:700">N/A</span>';
  }

  function renderFormResponseSection(report) {
    const fr = report.formResponses;
    // ProtonDB reports often have no form responses - just a raw rating. Show
    // what's available and explain the gap
    const hasResponses = fr && typeof fr === 'object' && (fr.canInstall || fr.canStart || fr.canPlay || fr.verdict);

    // Count faults if form responses present
    let faultCount = 0;
    if (hasResponses) {
      for (const k of FAULT_KEYS) if (fr[k] === 'yes') faultCount++;
    }

    const ratingBg = RATING_COLORS[report.rating] || '#3a4a5a';
    const ratingFg = RATING_TEXT_COLOR[report.rating] || '#fff';

    if (!hasResponses) {
      return `
        <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>Rating derivation</h3>
        <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">This report carries a <span style="display:inline-block;padding:1px 8px;border-radius:3px;background:${ratingBg};color:${ratingFg};font-size:0.78rem;font-weight:700;text-transform:uppercase">${esc(report.rating || 'unknown')}</span> rating.
        No structured form responses are available (typical for ProtonDB archive reports). The rating was assigned directly by the reporter or inferred from their free-text notes.</p>
        <div class="cb-formula">
          Rating <strong>${esc(report.rating || 'unknown')}</strong> &rarr; baseline confidence <strong>${RATING_BASE[report.rating] ?? 30}</strong> of a maximum 60.
          Higher tiers start with more baseline because they reflect deeper testing.
        </div>
      `;
    }

    // Build the step-by-step derivation flow
    const installChain = [
      { q: 'Can install?',  val: fr.canInstall },
      { q: 'Can start?',    val: fr.canStart },
      { q: 'Can play?',     val: fr.canPlay },
    ];
    const installFailed = fr.canInstall === 'no' || fr.canStart === 'no' || fr.canPlay === 'no';

    const faultRows = FAULT_KEYS.map(k => {
      const val = fr[k];
      if (val == null) return '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:0.82rem"><span style="color:var(--muted);min-width:160px">${FAULT_LABELS[k]}</span>${ynBadge(val)}</div>`;
    }).filter(Boolean).join('');

    return `
      <h3 style="margin:18px 0 8px;font-size:0.88rem;color:var(--strong)">Rating derivation</h3>
      <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">The rating comes from the reporter's yes/no answers. These answers feed into a deterministic algorithm - same answers always produce the same rating.</p>

      <div style="background:var(--s1);border:1px solid var(--border);padding:14px 16px;margin-bottom:14px">
        <div style="font-size:0.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Install chain</div>
        <div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:10px">
          ${installChain.map(s => `<div style="display:flex;align-items:center;gap:6px;font-size:0.82rem"><span style="color:var(--text)">${s.q}</span>${ynBadge(s.val)}</div>`).join('')}
        </div>
        ${installFailed ? '<div style="font-size:0.82rem;color:#c85050;font-weight:600">Install/start/play failure detected &rarr; rating forced to Borked regardless of other answers.</div>' : ''}

        ${!installFailed && faultRows ? `
          <div style="font-size:0.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin:14px 0 8px">Fault questions (${faultCount} reported)</div>
          ${faultRows}
        ` : ''}

        ${!installFailed ? `
          <div style="font-size:0.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin:14px 0 8px">Final verdict</div>
          <div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:6px;font-size:0.82rem"><span style="color:var(--text)">Would recommend?</span>${ynBadge(fr.verdict)}</div>
            <div style="display:flex;align-items:center;gap:6px;font-size:0.82rem"><span style="color:var(--text)">Works out of the box?</span>${ynBadge(fr.verdictOob)}</div>
          </div>
        ` : ''}

        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px">
          <span style="font-size:0.82rem;color:var(--text)">Derived rating:</span>
          <span style="display:inline-block;padding:3px 12px;border-radius:3px;background:${ratingBg};color:${ratingFg};font-size:0.82rem;font-weight:700;text-transform:uppercase">${esc(report.rating || 'unknown')}</span>
          <span style="font-size:0.78rem;color:var(--muted)">&rarr; baseline confidence: <strong style="color:var(--text)">${RATING_BASE[report.rating] ?? 30}</strong> / 60</span>
        </div>
        <div style="font-size:0.74rem;color:var(--muted);margin-top:6px">
          ${!installFailed && faultCount >= 3 ? 'Rule: 3+ faults &rarr; Bronze' :
            !installFailed && faultCount === 2 ? 'Rule: 2 faults &rarr; Silver' :
            !installFailed && faultCount === 1 ? 'Rule: 1 fault &rarr; Gold' :
            !installFailed && fr.verdictOob === 'yes' ? 'Rule: 0 faults + works OOB &rarr; Platinum' :
            !installFailed && fr.verdict === 'yes' ? 'Rule: 0 faults, needed tweaks &rarr; Gold' :
            installFailed ? 'Rule: install/start/play failure &rarr; Borked' :
            'Rating determined by the combination of answers above'}
        </div>
      </div>
    `;
  }

  function daysAgo(ts) {
    if (!ts) return 'unknown';
    const d = Math.round((Date.now() / 1000 - ts) / 86400);
    return d <= 0 ? 'today' : d === 1 ? '1 day ago' : d + ' days ago';
  }

  function renderFactor(label, detail, value, note) {
    return `<div class="cb-factor">
      <div>
        <div class="cb-factor-label">${esc(label)}</div>
        <div class="cb-factor-detail">${esc(detail)}</div>
        ${note ? `<div class="cb-factor-detail" style="color:var(--text);margin-top:4px">${note}</div>` : ''}
      </div>
      <div class="cb-factor-value ${valueClass(value)}">${valuePrefix(value)}${value}</div>
    </div>`;
  }

  // Per-report breakdown. Shows scoring factors including hardware match when
  // the viewer has saved hardware in their profile (localStorage).
  function renderReportBreakdown(report, gameTitle, appId, myHw, scoringData) {
    const bd = estimateScoreBreakdown(report);
    const w = scoringData?.weights || {};
    const osFamilies = scoringData?.osFamilies || null;
    const hwFactors = (myHw && Object.keys(w).length) ? computeHwFactors(myHw, report, w, osFamilies) : [];
    const adjustedTotal = hwFactors.length ? Math.min(100, Math.round(applyHwFactors(bd.total, hwFactors))) : bd.total;
    const total = adjustedTotal;
    const totalBg = confColorAt(total);
    const totalFg = confTextAt(total);
    const days = bd.meta?.days ?? 0;
    const base = RATING_BASE[report.rating] ?? 30;

    // Contextual flags the page shows alongside the math
    const isDeck = /vangogh|0405|0932|sephiroth/i.test(`${report.cpu || ''} ${report.gpu || ''}`);
    const hasDuration = report.duration && report.duration !== 'unreported';
    const hasNotes = !!report.notes;

    return `
      <div class="cb-header">
        <div class="cb-header-game">
          <div class="name">${esc(gameTitle)}</div>
          <div class="sub">App ${esc(appId)}${report.reportId != null ? ' / Report #' + report.reportId : ''} / ${esc(report.protonVersion || 'Unknown Proton')} / ${daysAgo(report.timestamp)}</div>
        </div>
        <span class="cb-total" style="background:${totalBg};color:${totalFg}">
          <span class="label">Confidence</span> ${total}%
        </span>
      </div>

      ${renderFormResponseSection(report)}

      <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>Confidence scoring factors</h3>
      <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">The rating above becomes the confidence baseline. These factors then adjust it.</p>
      <div class="cb-factors">
        ${renderFactor(
          'Rating baseline',
          `The report rated this game "${report.rating || 'unknown'}" which starts at ${base} of a possible 60`,
          base,
          `Platinum=60, Gold=48, Silver=36, Bronze=24, Borked=0. Higher-rated reports start with more baseline confidence because they reflect deeper testing.`
        )}
        ${renderFactor(
          'Recency',
          `Report is ${days} day${days !== 1 ? 's' : ''} old (${days < 90 ? 'recent - full bonus' : days < 365 ? 'moderate age - partial bonus' : 'old - penalty applied'})`,
          days < 90 ? 15 : days < 365 ? 5 : -5,
          `Fresh reports (&lt;90d) add +15, moderate (90-365d) add +5, old (&gt;1yr) subtract -5. Newer data is more likely to reflect the current state of the game + Proton.`
        )}
      </div>

      <div class="cb-formula">
        <strong>${base} + ${days < 90 ? 15 : days < 365 ? 5 : -5} = ${bd.meta?.raw ?? bd.total}</strong>
        ${bd.meta?.cappedAtZero ? '(clamped to 0, confidence cannot go negative)' : ''}
        ${hwFactors.length ? `&times; hardware multipliers &rarr; <strong>Adjusted: ${adjustedTotal}%</strong>` : `&rarr; <strong>Confidence: ${bd.total}%</strong>`}
      </div>

      ${hwFactors.length ? `
        <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>Your hardware match</h3>
        <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">Loaded from your saved profile. These multipliers adjust relevance based on how closely the reporter's setup matches yours.</p>
        <div class="cb-factors">
          ${hwFactors.map(f => `
            <div class="cb-factor">
              <div>
                <div class="cb-factor-label">${esc(f.label)}</div>
                <div class="cb-factor-detail">${esc(f.detail)}</div>
                <div class="cb-factor-detail" style="color:var(--text);margin-top:3px">${f.note}</div>
              </div>
              <div class="cb-factor-value ${f.matched === true ? 'cb-positive' : f.matched === false ? 'cb-negative' : 'cb-neutral'}">${f.multiplier.toFixed(2)}x</div>
            </div>`).join('')}
        </div>
        <div class="cb-formula">
          Base score ${bd.total}% &times; ${hwFactors.map(f => f.multiplier.toFixed(2)).join(' &times; ')} &rarr; <strong>${adjustedTotal}%</strong>
        </div>` : `
        <div class="cb-disclaimer">
          <strong>Hardware match factors not shown.</strong> Save your hardware on the <a href="profile.html" style="color:var(--accent-hi)">Profile page</a> to see GPU, OS, and kernel match scores personalized to your system. The Decky plugin computes these automatically from your Steam Deck specs.
        </div>`}

      <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg>Report context</h3>
      <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">Additional details about this report.</p>
      <div class="cb-factors">
        <div class="cb-factor"><div><div class="cb-factor-label">Hardware</div><div class="cb-factor-detail">${esc(report.gpu || 'Unknown GPU')} / ${esc(report.os || 'Unknown OS')}</div></div><div class="cb-factor-value cb-neutral">${isDeck ? 'Steam Deck' : 'Desktop'}</div></div>
        <div class="cb-factor"><div><div class="cb-factor-label">Proton version</div><div class="cb-factor-detail">${esc(report.protonVersion || 'Not specified')}</div></div><div class="cb-factor-value cb-neutral">context</div></div>
        <div class="cb-factor"><div><div class="cb-factor-label">Playtime</div><div class="cb-factor-detail">${hasDuration ? esc(report.duration) : 'Not reported'}</div></div><div class="cb-factor-value ${hasDuration ? 'cb-positive' : 'cb-neutral'}">${hasDuration ? 'reported' : 'absent'}</div></div>
        <div class="cb-factor"><div><div class="cb-factor-label">Notes</div><div class="cb-factor-detail">${hasNotes ? (report.notes.length > 80 ? esc(report.notes.slice(0, 80)) + '...' : esc(report.notes)) : 'None provided'}</div></div><div class="cb-factor-value ${hasNotes ? 'cb-positive' : 'cb-neutral'}">${hasNotes ? report.notes.length + ' chars' : 'absent'}</div></div>
      </div>

      <a class="cb-back" href="confidence.html?app=${esc(appId)}">&larr; Back to aggregate stats</a>
    `;
  }

  // Smooth SVG cubic bezier path through an array of {x,y} points.
  function smoothPath(pts) {
    if (!pts.length) return '';
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const cx = ((pts[i].x + pts[i + 1].x) / 2).toFixed(1);
      d += ` C ${cx} ${pts[i].y.toFixed(1)} ${cx} ${pts[i + 1].y.toFixed(1)} ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
    }
    return d;
  }

  // SVG dual-line area chart: positive (silver+) vs negative (bronze/borked) reports over time.
  // Returns { html, wire }. Caller injects html into the DOM, then calls
  // wire() so the chart-interactions helper can attach hover handlers to
  // the live <rect class="ci-hover-target"> nodes
  function buildHistoryChart(reports) {
    if (!reports.length) return {
      html: '<div style="color:var(--muted);font-size:0.78rem">No report history available.</div>',
      wire: () => {},
    };

    // Bucket reports by year-month for last 24 months
    const now = Date.now() / 1000;
    const MONTHS = 24;
    const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const rawBuckets = {};
    for (const r of reports) {
      if (!r.timestamp) continue;
      const d = new Date(r.timestamp * 1000);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!rawBuckets[key]) rawBuckets[key] = { pos: 0, neg: 0 };
      if (['platinum','gold','silver'].includes(r.rating)) rawBuckets[key].pos++;
      else rawBuckets[key].neg++;
    }

    // Walk month-by-month from the earlier of (earliest report, 24 months ago)
    // up to NOW. The old version added 30.5 days * 24 iterations which always
    // ended in the future when the earliest report was recent, painting an
    // empty band of flat-zero months into next year. Iterating actual months
    // also avoids the 30.5-day drift over long spans
    const earliestTs = Math.min(...reports.map(r => r.timestamp || now));
    const windowStart = Math.max(earliestTs, now - MONTHS * 30.5 * 86400);
    const startDate = new Date(windowStart * 1000);
    const endDate = new Date(now * 1000);
    const monthKeys = [];
    let y = startDate.getFullYear();
    let m = startDate.getMonth();
    const endY = endDate.getFullYear();
    const endM = endDate.getMonth();
    while (y < endY || (y === endY && m <= endM)) {
      monthKeys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }

    const data = monthKeys.map(k => ({ key: k, ...(rawBuckets[k] || { pos: 0, neg: 0 }) }));
    const maxCount = Math.max(1, ...data.map(d => d.pos + d.neg));
    const hasAny = data.some(d => d.pos + d.neg > 0);
    if (!hasAny) return {
      html: '<div style="color:var(--muted);font-size:0.78rem">No timestamped report history available.</div>',
      wire: () => {},
    };

    // Bigger viewBox + preserveAspectRatio="none" so the chart stretches
    // edge-to-edge. Both PAD_L and PAD_R stay small so the line fills the
    // full width; y-axis numbers (13 / 7 / 0) render inside the chart at
    // their reference y, anchored to start so they sit just to the right
    // of the left edge instead of eating a 36px gutter
    const W = 1000, H = 200, PAD_L = 8, PAD_R = 8, PAD_B = 26, PAD_T = 12;
    const cW = W - PAD_L - PAD_R;
    const cH = H - PAD_B - PAD_T;
    const n = data.length;
    const xStep = n > 1 ? cW / (n - 1) : 0;
    const yFor = v => (PAD_T + cH - (v / maxCount) * cH).toFixed(1);
    const baseY = (PAD_T + cH).toFixed(1);

    const xAt = i => PAD_L + i * xStep;
    const yPos = item => parseFloat(yFor(item.pos));
    const yNeg = item => parseFloat(yFor(item.neg));

    const posPoints = data.map((d, i) => ({ x: xAt(i), y: yPos(d) }));
    const negPoints = data.map((d, i) => ({ x: xAt(i), y: yNeg(d) }));
    const posLine = smoothPath(posPoints);
    const negLine = smoothPath(negPoints);
    const posArea = `${posLine} L ${posPoints[n-1].x.toFixed(1)} ${baseY} L ${PAD_L} ${baseY} Z`;
    const negArea = `${negLine} L ${negPoints[n-1].x.toFixed(1)} ${baseY} L ${PAD_L} ${baseY} Z`;

    // y-axis numbers sit INSIDE the chart area at their reference y,
    // anchored to start so they cling to the left edge. They render above
    // the line for the top tick (maxCount), at the line for the midpoint,
    // and slightly above the baseline for 0 so the 0 doesn't get clipped
    const yTicks = [0, Math.round(maxCount / 2), maxCount].map(v => {
      const baseline = parseFloat(yFor(v));
      // Top tick: 12px below baseline (so it sits BELOW the topmost line)
      // Mid + 0: 4px above baseline (so they hover above the reference line)
      const yPos = v === maxCount ? baseline + 12 : baseline - 4;
      return `<text x="${PAD_L + 2}" y="${yPos}" text-anchor="start" fill="#7a9bb5" font-size="10" font-family="var(--mono)">${v}</text>`;
    }).join('');

    // Edge labels (first / last) use start / end anchoring so they stay
    // inside the chart even though their data points sit at the edges.
    // Middle labels stay centered on their tick
    const labelEvery = Math.ceil(n / 8);
    const xLabels = data.map((d, i) => {
      if (i % labelEvery !== 0 && i !== n - 1 && i !== 0) return '';
      const [yr, mo] = d.key.split('-');
      const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      return `<text x="${xAt(i).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" fill="#7a9bb5" font-size="10">${MONTH_ABBR[parseInt(mo)-1]} '${yr.slice(2)}</text>`;
    }).join('');

    const gridLines = [0.25, 0.5, 0.75].map(f =>
      `<line x1="${PAD_L}" y1="${(PAD_T + cH * (1-f)).toFixed(1)}" x2="${PAD_L + cW}" y2="${(PAD_T + cH * (1-f)).toFixed(1)}" stroke="#1e2e3e" stroke-width="1"/>`
    ).join('');

    // Single full-width hover target so the cursor tracks continuously
    // across the chart instead of snapping to discrete column rects. The
    // helper picks the nearest data point on mousemove
    const targets = `<rect class="ci-hover-target ci-hover-full" x="${PAD_L}" y="${PAD_T}" width="${cW}" height="${cH}" fill="transparent"/>`;

    const html = `
      <div class="cb-history-chart" id="cb-history-chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:240px;display:block" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="hcPosGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#66c0f4" stop-opacity="0.35"/>
              <stop offset="100%" stop-color="#66c0f4" stop-opacity="0.03"/>
            </linearGradient>
            <linearGradient id="hcNegGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#c85050" stop-opacity="0.35"/>
              <stop offset="100%" stop-color="#c85050" stop-opacity="0.03"/>
            </linearGradient>
          </defs>
          ${gridLines}
          <line x1="${PAD_L}" y1="${PAD_T + cH}" x2="${PAD_L + cW}" y2="${PAD_T + cH}" stroke="#2a3a4a" stroke-width="1"/>
          ${yTicks}
          <path d="${posArea}" fill="url(#hcPosGrad)"/>
          <path d="${negArea}" fill="url(#hcNegGrad)"/>
          <path d="${posLine}" fill="none" stroke="#66c0f4" stroke-width="1.8"/>
          <path d="${negLine}" fill="none" stroke="#c85050" stroke-width="1.8"/>
          ${xLabels}
          <line class="ci-hover-guide" id="cb-hc-guide" x1="0" y1="${PAD_T}" x2="0" y2="${PAD_T + cH}"/>
          <circle class="ci-hover-dot" id="cb-hc-dot-pos" r="4" fill="#66c0f4"/>
          <circle class="ci-hover-dot" id="cb-hc-dot-neg" r="4" fill="#c85050"/>
          ${targets}
        </svg>
        <div class="ci-tooltip" id="cb-hc-tip"></div>
        <div style="display:flex;gap:16px;margin-top:2px;font-size:0.72rem;color:var(--muted)">
          <span><span style="display:inline-block;width:12px;height:3px;background:#66c0f4;border-radius:1px;vertical-align:middle;margin-right:4px"></span>Positive (silver+)</span>
          <span><span style="display:inline-block;width:12px;height:3px;background:#c85050;border-radius:1px;vertical-align:middle;margin-right:4px"></span>Negative (bronze/borked)</span>
        </div>
      </div>
    `;

    const wire = () => {
      const host = document.getElementById('cb-history-chart');
      if (!host || typeof attachChartHover !== 'function') return;
      const svg = host.querySelector('svg');
      const tooltip = document.getElementById('cb-hc-tip');
      const guide = document.getElementById('cb-hc-guide');
      const dotPos = document.getElementById('cb-hc-dot-pos');
      const dotNeg = document.getElementById('cb-hc-dot-neg');
      const fmt = key => { const [yr, mo] = key.split('-'); return `${MONTH_ABBR[parseInt(mo)-1]} '${yr.slice(2)}`; };
      attachChartHover({
        svg, host, tooltip, guide,
        dots: [dotPos, dotNeg],
        data,
        getX: xAt,
        getYForDot: (item, dotIdx) => dotIdx === 0 ? yPos(item) : yNeg(item),
        renderTip: item => `
          <div class="ci-tip-month">${fmt(item.key)}</div>
          <div class="ci-tip-row">
            <span class="ci-tip-dot" style="background:#66c0f4"></span>
            <span>Positive</span>
            <span class="ci-tip-val">${item.pos}</span>
          </div>
          <div class="ci-tip-row">
            <span class="ci-tip-dot" style="background:#c85050"></span>
            <span>Negative</span>
            <span class="ci-tip-val">${item.neg}</span>
          </div>
        `,
      });
    };

    return { html, wire };
  }

  function computeTrend(reports) {
    const now = Date.now() / 1000;
    const RATING_VAL = { platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1 };
    const recent = reports.filter(r => r.timestamp && now - r.timestamp < 90 * 86400);
    const prior  = reports.filter(r => r.timestamp && now - r.timestamp >= 90 * 86400 && now - r.timestamp < 270 * 86400);
    const avg = arr => arr.reduce((s, r) => s + (RATING_VAL[r.rating] || 3), 0) / arr.length;
    if (recent.length >= 2 && prior.length >= 2) {
      const diff = avg(recent) - avg(prior);
      return { dir: diff > 0.3 ? 'improving' : diff < -0.3 ? 'declining' : 'stable', diff, recentCount: recent.length, priorCount: prior.length };
    }
    return { dir: 'insufficient', diff: 0, recentCount: recent.length, priorCount: prior.length };
  }

  function computeVersionStats(reports) {
    const map = {};
    for (const r of reports) {
      const ver = r.protonVersion || r.proton_version || 'Unknown';
      if (!map[ver]) map[ver] = { total: 0, pos: 0 };
      map[ver].total++;
      if (['platinum','gold','silver'].includes(r.rating)) map[ver].pos++;
    }
    return Object.entries(map)
      .map(([ver, s]) => ({ ver, total: s.total, pct: Math.round((s.pos / s.total) * 100) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  }

  function computeLaunchFlags(reports) {
    const flagMap = {};
    const withOpts = reports.filter(r => r.launchOptions || r.launch_options);
    for (const r of withOpts) {
      const lo = r.launchOptions || r.launch_options || '';
      const tokens = lo.split(/\s+/).filter(t => t.startsWith('%') || t.startsWith('-') || /^[A-Z_]+=/.test(t));
      for (const tok of tokens) flagMap[tok] = (flagMap[tok] || 0) + 1;
    }
    const total = withOpts.length;
    return Object.entries(flagMap)
      .map(([flag, cnt]) => ({ flag, cnt, pct: total > 0 ? Math.round((cnt / total) * 100) : 0 }))
      .sort((a, b) => b.cnt - a.cnt)
      .slice(0, 10);
  }

  // Aggregate breakdown for a whole game. Shows the rating distribution,
  // how sample size curves into confidence, and what the freshness of the
  // data pool means for trust.
  function renderGameBreakdown(reports, gameTitle, appId) {
    const n = reports.length;
    const displayed = Math.min(95, Math.round(30 + Math.log2(Math.max(1, n)) * 18));
    const newestTs = n ? Math.max(...reports.map(r => r.timestamp || 0)) : 0;
    const daysSinceNewest = newestTs ? Math.round((Date.now() / 1000 - newestTs) / 86400) : Infinity;
    const freshnessAdjust = daysSinceNewest < 180 ? 0
      : daysSinceNewest > 365 * 3 ? -15
      : Math.round(-15 * ((daysSinceNewest - 180) / (365 * 3 - 180)));

    const totalBg = confColorAt(displayed);
    const totalFg = confTextAt(displayed);

    // Rating distribution -- one row per tier matching the per-version
    // success bars below. Width 150px label / flex bar / pct / count, same
    // pattern as the bottom of the page so the layouts line up visually
    const counts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0 };
    for (const r of reports) if (counts[r.rating] != null) counts[r.rating]++;
    const TIER_LABEL = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked' };
    const distChips = Object.entries(counts).map(([tier, cnt]) => {
      const pct = n > 0 ? Math.round(cnt / n * 100) : 0;
      const barColor = RATING_COLORS[tier] || '#3a4a5a';
      const inactive = cnt === 0;
      return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;opacity:${inactive ? 0.45 : 1}">
        <span style="min-width:150px;font-size:0.78rem;font-weight:700;color:${barColor};text-transform:uppercase;letter-spacing:0.05em">${TIER_LABEL[tier]}</span>
        <div style="flex:1;background:var(--bg);border-radius:2px;height:7px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${barColor};border-radius:2px;transition:width 0.3s"></div>
        </div>
        <span style="width:38px;text-align:right;font-weight:700;color:${barColor}">${pct}%</span>
        <span style="width:30px;text-align:right;color:var(--muted);font-size:0.72rem">${cnt}r</span>
      </div>`;
    }).join('');

    // Mean per-report confidence
    const breakdowns = reports.map(estimateScoreBreakdown);
    const meanConf = breakdowns.length
      ? Math.round(breakdowns.reduce((a, b) => a + b.total, 0) / breakdowns.length)
      : 0;
    const scores = breakdowns.map(b => b.total).sort((a, b) => a - b);
    const lowestConf = scores[0] ?? 0;
    const highestConf = scores[scores.length - 1] ?? 0;

    // Trend
    const trend = computeTrend(reports);
    const TREND_COLOR = { improving: '#5ba32b', declining: '#c85050', stable: 'var(--text)', insufficient: 'var(--muted)' };
    const TREND_LABEL = { improving: 'Improving', declining: 'Declining', stable: 'Stable', insufficient: 'Insufficient data' };
    const trendIcon = trend.dir === 'improving'
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15l-6-6-6 6"/></svg>'
      : trend.dir === 'declining'
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg>';

    // Version stats
    const versionStats = computeVersionStats(reports);
    const verRows = versionStats.length
      ? versionStats.map(v => {
          const barColor = v.pct >= 75 ? '#5ba32b' : v.pct >= 50 ? '#e0a030' : '#c85050';
          return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
            <span style="min-width:150px;font-size:0.75rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v.ver)}">${esc(v.ver)}</span>
            <div style="flex:1;background:var(--bg);border-radius:2px;height:7px;overflow:hidden">
              <div style="width:${v.pct}%;height:100%;background:${barColor};border-radius:2px;transition:width 0.3s"></div>
            </div>
            <span style="width:38px;text-align:right;font-weight:700;color:${barColor}">${v.pct}%</span>
            <span style="width:30px;text-align:right;color:var(--muted);font-size:0.72rem">${v.total}r</span>
          </div>`;
        }).join('')
      : '<div style="color:var(--muted);font-size:0.78rem">No Proton version data available.</div>';

    // Launch flags
    const launchFlags = computeLaunchFlags(reports);
    const flagRows = launchFlags.length
      ? launchFlags.map(f => `
          <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
            <code style="min-width:180px;font-size:0.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.flag)}</code>
            <div style="flex:1;background:var(--bg);border-radius:2px;height:7px;overflow:hidden">
              <div style="width:${Math.min(100,f.pct)}%;height:100%;background:var(--accent);border-radius:2px"></div>
            </div>
            <span style="width:38px;text-align:right;font-weight:700">${f.pct}%</span>
            <span style="width:28px;text-align:right;color:var(--muted);font-size:0.72rem">${f.cnt}x</span>
          </div>`).join('')
      : '<div style="color:var(--muted);font-size:0.78rem">No launch option data in reports.</div>';

    // Chart now returns { html, wire } so the hover handler can attach
    // after innerHTML lands. wire() is invoked by the caller (run())
    const history = buildHistoryChart(reports);

    // Overall tier = mode of ratings (most common); on a tie prefer higher
    // tier so an even split between gold and silver shows gold. Same intent
    // as the badge on the main game page so the user sees the same rating
    // here as they saw to get here in the first place
    const TIER_ORDER = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
    const TIER_LBL = { platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked' };
    let overallTier = null;
    if (n > 0) {
      const tierCounts = {};
      for (const r of reports) if (counts[r.rating] != null) {
        tierCounts[r.rating] = (tierCounts[r.rating] || 0) + 1;
      }
      let bestCount = -1;
      for (const t of TIER_ORDER) {
        if ((tierCounts[t] || 0) > bestCount) {
          bestCount = tierCounts[t];
          overallTier = t;
        }
      }
    }
    const tierBg = overallTier ? (RATING_COLORS[overallTier] || '#3a4a5a') : 'transparent';
    const tierFg = (overallTier === 'bronze' || overallTier === 'borked') ? '#fff' : '#111';
    const tierBadge = overallTier
      ? `<span class="cb-total" style="background:${tierBg};color:${tierFg};margin-left:8px">${TIER_LBL[overallTier]}</span>`
      : '';

    const html = `
      <div class="cb-header">
        <div class="cb-header-game">
          <div class="name">${esc(gameTitle)}</div>
          <div class="sub">App ${esc(appId)} / ${n} report${n !== 1 ? 's' : ''} / newest ${daysAgo(newestTs)}</div>
        </div>
        <span class="cb-total" style="background:${totalBg};color:${totalFg}">
          <span class="label">Confidence</span> ${displayed}%
        </span>
        ${tierBadge}
      </div>

      <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Report history</h3>
      <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">Positive (silver+) vs. negative (bronze/borked) reports submitted over time.</p>
      ${history.html}

      <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>Compatibility trend</h3>
      <p style="font-size:0.82rem;color:var(--muted);margin:0 0 8px">Comparing average rating in last 90 days vs. the prior 90-270 day window.</p>
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--s1);border:1px solid var(--border);border-left:3px solid ${TREND_COLOR[trend.dir]}">
        <span style="color:${TREND_COLOR[trend.dir]};display:flex;align-items:center;gap:4px;font-weight:700">${trendIcon} ${TREND_LABEL[trend.dir]}</span>
        ${trend.dir !== 'insufficient'
          ? `<span style="color:var(--muted);font-size:0.78rem">${trend.recentCount} report${trend.recentCount !== 1 ? 's' : ''} last 90d vs ${trend.priorCount} in prior 90-270d window</span>`
          : `<span style="color:var(--muted);font-size:0.78rem">Need at least 2 reports in each window for trend analysis.</span>`}
      </div>

      <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/></svg>Rating distribution</h3>
      <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">How the ${n} reports break down by tier.</p>
      <div style="margin-bottom:16px">${distChips}</div>

      <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Confidence factors</h3>
      <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">Confidence is driven by sample size, rating consistency, and data freshness.</p>
      <div class="cb-factors">
        ${renderFactor(
          'Sample size',
          `${n} report${n !== 1 ? 's' : ''} on a log-scaled curve`,
          displayed,
          `1 report=30%, 5=60%, 20=85%, 50+=~95%. This game has ${n} report${n !== 1 ? 's' : ''} -- baseline sits at ${displayed}%.`
        )}
        ${renderFactor(
          'Mean per-report confidence',
          `Average of all ${n} individual report confidence scores`,
          meanConf,
          `Range: lowest ${lowestConf}% to highest ${highestConf}%. Higher-rated, more recent reports score higher individually.`
        )}
        ${renderFactor(
          'Freshness',
          `Newest report was ${daysAgo(newestTs)} (${daysSinceNewest === Infinity ? 'unknown' : daysSinceNewest + 'd'})`,
          freshnessAdjust,
          daysSinceNewest < 180 ? 'Data is fresh (under 6 months) -- no penalty.'
            : `Data pool is aging. Newest report is ${daysSinceNewest} days old.`
        )}
      </div>

      <div class="cb-formula">
        Confidence <strong>${displayed}%</strong> with ${n} report${n !== 1 ? 's' : ''}, newest from ${daysAgo(newestTs)}.
        Data pool is ${displayed >= 80 ? 'strong' : displayed >= 50 ? 'moderate' : 'thin'}.
        ${freshnessAdjust < 0 ? `Freshness penalty: -${Math.abs(freshnessAdjust)} points.` : ''}
      </div>

      <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M4.93 4.93a10 10 0 000 14.14"/></svg>Per-Proton-version success</h3>
      <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">% of reports rated silver or better per Proton version (sorted by report count).</p>
      ${verRows}

      <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M3 9h6"/><path d="M3 15h6"/><path d="M12 9h9"/><path d="M12 15h9"/></svg>Common launch option flags</h3>
      <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px">Frequency of each flag across reports that include launch options.</p>
      ${flagRows}

      <h3 class="cb-section-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 2.4-1.2 4.5-3 5.7V17a1 1 0 01-1 1h-6a1 1 0 01-1-1v-2.3C6.2 13.5 5 11.4 5 9a7 7 0 017-7z"/><line x1="9" y1="21" x2="15" y2="21"/></svg>What this means</h3>
      <div class="cb-formula">
        ${displayed >= 80 ? `<strong>High confidence.</strong> Strong data pool with broad consensus.` :
          displayed >= 50 ? `<strong>Moderate confidence.</strong> Enough reports to show a trend, but more data would help.` :
          `<strong>Low confidence.</strong> Few reports -- take the tier badge with a grain of salt.`}
        ${n > 0 ? ` View individual report breakdowns on the <a href="app.html#/app/${esc(appId)}" style="color:var(--accent-hi)">game page</a>.` : ''}
      </div>

      <a class="cb-back" href="app.html#/app/${esc(appId)}">&larr; Back to ${esc(gameTitle)}</a>
    `;

    return { html, wire: history.wire };
  }

  async function loadGame(appId, year) {
    // If a specific year is known (derived from report timestamp), try that
    // bucket first -- latest.json only mirrors the most recent year file so
    // older reports won't be found there.
    const files = (year && String(year) !== String(new Date().getFullYear()))
      ? [`${year}.json`, 'latest.json']
      : ['latest.json'];
    for (const file of files) {
      try {
        const r = await fetch(`${CDN_BASE}/${appIdToDir(appId)}/${file}`);
        if (!r.ok) continue;
        const data = await r.json();
        if (Array.isArray(data) && data.length) return data;
      } catch { continue; }
    }
    return [];
  }

  async function loadSearchIndexLocal() {
    try {
      const url = _usesProdData
        ? 'https://www.proton-pulse.com/search-index.json'
        : `${location.origin}${SITE_BASE}/search-index.json`;
      const r = await fetch(url);
      return r.ok ? await r.json() : [];
    } catch { return []; }
  }

  async function run() {
    const params = new URLSearchParams(location.search);
    const appId = params.get('app');
    const reportId = params.get('report');
    // CDN reports don't have reportId - use timestamp as fallback identifier.
    // The per-report link on the game page sends &ts=XXXXXXX for CDN reports
    const reportTs = params.get('ts');
    const reportYear = reportTs ? new Date(parseInt(reportTs, 10) * 1000).getFullYear() : null;
    // Only show the aggregate when there's NO per-report identifier at all
    const wantsPerReport = !!(reportId || reportTs);

    if (!appId) {
      root.innerHTML = `<div class="error-state">
        <p>No app id in URL.</p>
        <p style="font-size:0.78rem;margin-top:8px">Expected
        <code>?app=1091500&ts=1716000000</code> for a specific report, or
        <code>?app=1091500</code> for the overall aggregate.</p>
      </div>`;
      return;
    }

    const myHw = loadMyHardware();
    const [reports, searchIndex, scoringData] = await Promise.all([
      loadGame(appId, reportYear),
      loadSearchIndexLocal(),
      wantsPerReport ? loadScoringInfo() : Promise.resolve(null),
    ]);
    const indexHit = (searchIndex || []).find(row => String(row[0]) === String(appId));
    const gameTitle = reports[0]?.title || indexHit?.[1] || `App ${appId}`;

    // Tag the meta line based on whether we're using saved or preview hw
    const hwLabel = isPreviewHardware(myHw)
      ? 'Steam Deck preview'
      : (myHw.gpuVendor || myHw.gpu || 'unknown GPU');
    metaEl.textContent = `// Computed from ${reports.length} report${reports.length === 1 ? '' : 's'} on ${appId} -- hardware match active (${hwLabel})`;

    const previewBanner = isPreviewHardware(myHw) ? renderPreviewHardwareBanner() : '';

    if (wantsPerReport) {
      const target = reportId
        ? reports.find(r => String(r.reportId) === String(reportId))
        : reports.find(r => String(r.timestamp) === String(reportTs));
      if (!target) {
        root.innerHTML = `<div class="error-state">
          <p>Report not found for app ${esc(appId)}.</p>
          <a class="cb-back" href="confidence.html?app=${esc(appId)}">&larr; Back to aggregate stats</a>
        </div>`;
        return;
      }
      root.innerHTML = previewBanner + renderReportBreakdown(target, gameTitle, appId, myHw, scoringData);
    } else {
      const out = renderGameBreakdown(reports, gameTitle, appId);
      root.innerHTML = previewBanner + out.html;
      // wire chart hover handlers AFTER innerHTML lands so the helper can
      // measure live SVG nodes (otherwise hover targets stay inert)
      if (typeof out.wire === 'function') out.wire();
    }
  }

  run();
})();
