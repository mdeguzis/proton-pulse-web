// Admin "Logging" tab (#366). Renders the in-memory log ring buffer
// (js/lib/log-buffer.js) as a scrollable table with level / module / text
// filters, a live-tail toggle, and a Copy JSON button. Mobile debugging
// story: hit any page with ?loglevel=debug, exercise the bug, open the
// admin panel on the same session, click Logging -- the last N entries
// are right there without needing Chrome remote devtools.
//
// This tab reads ONLY from the local ring. Server-side logs (site_events
// where event_type='log') are a separate query and out of scope for the
// first cut; the ring already sees every ppTrack call because analytics.js
// pushes into it before the fetch to Supabase.

import {
  getLogs,
  subscribeLog,
  clearLogs,
  activeLevel,
  setActiveLevel,
  LEVEL_ORDER,
} from '../../lib/log-buffer.js?v=6d7ce577';

const LEVEL_COLORS = {
  DEBUG: '#8a8f98',
  INFO:  '#3aaa5b',
  WARN:  '#d98b1f',
  ERROR: '#d0453f',
};

// UI state kept out of module top-level so unit tests can rebuild the tab
// without leaked filters from a prior render.
let _state = null;

function _initState() {
  _state = {
    levelFilter: '',        // '' = all
    moduleFilter: '',       // '' = all (matches ctx.source / ctx.event_type / ctx.module)
    textFilter: '',
    liveTail: true,
    unsub: null,
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Modules are derived from whatever tag the caller stuck on the ctx: prefer
// ctx.source, fall back to ctx.event_type / ctx.module. Anything with no
// tag lands under '(untagged)' so the filter dropdown does not lie.
function _moduleOf(entry) {
  const c = entry && entry.ctx;
  return (c && (c.source || c.event_type || c.module)) || '(untagged)';
}

function _filtered() {
  const rows = getLogs();
  const lvl = _state.levelFilter;
  const mod = _state.moduleFilter;
  const q = _state.textFilter.trim().toLowerCase();
  return rows.filter((r) => {
    if (lvl && r.level !== lvl) return false;
    if (mod && _moduleOf(r) !== mod) return false;
    if (q) {
      const hay = [r.msg, JSON.stringify(r.ctx || {})].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function _moduleOptions() {
  const set = new Set();
  for (const r of getLogs()) set.add(_moduleOf(r));
  return Array.from(set).sort();
}

function _fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function _rowHtml(entry) {
  const color = LEVEL_COLORS[entry.level] || LEVEL_COLORS.INFO;
  const ctxJson = entry.ctx && Object.keys(entry.ctx).length
    ? esc(JSON.stringify(entry.ctx))
    : '';
  return `
    <tr class="admin-log-row" data-level="${esc(entry.level)}">
      <td class="admin-log-time" title="${esc(new Date(entry.ts).toISOString())}">${_fmtTime(entry.ts)}</td>
      <td class="admin-log-level" style="color:${color}">${esc(entry.level)}</td>
      <td class="admin-log-module">${esc(_moduleOf(entry))}</td>
      <td class="admin-log-msg">${esc(entry.msg)}${ctxJson ? `<div class="admin-log-ctx">${ctxJson}</div>` : ''}</td>
    </tr>`;
}

function _renderTable(container) {
  const rows = _filtered();
  const tbody = container.querySelector('#admin-log-tbody');
  const meta = container.querySelector('#admin-log-meta');
  const total = getLogs().length;
  if (tbody) tbody.innerHTML = rows.map(_rowHtml).join('') ||
    '<tr><td colspan="4" class="admin-loading">No log entries match the current filters.</td></tr>';
  if (meta) meta.textContent = `${rows.length} shown / ${total} captured (session)`;
  if (_state.liveTail && tbody) {
    const scroller = container.querySelector('.admin-log-scroller');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}

function _refreshModuleOptions(container) {
  const sel = container.querySelector('#admin-log-module');
  if (!sel) return;
  const cur = sel.value;
  const opts = ['<option value="">All modules</option>']
    .concat(_moduleOptions().map((m) => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`))
    .join('');
  sel.innerHTML = opts;
}

// Public entry point wired into the admin TAB_LOADERS map. Renders the
// panel HTML once (idempotent -- subsequent activations just re-render the
// table + rebind the tail subscription).
export function renderLoggingTab() {
  if (!_state) _initState();
  const host = document.getElementById('tab-logging');
  if (!host) return;

  if (!host.dataset.mounted) {
    host.dataset.mounted = '1';
    host.innerHTML = `
      <div class="admin-toolbar">
        <select id="admin-log-level" class="admin-select" aria-label="Filter by level">
          <option value="">All levels</option>
          ${LEVEL_ORDER.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
        </select>
        <select id="admin-log-module" class="admin-select" aria-label="Filter by module">
          <option value="">All modules</option>
        </select>
        <input type="search" id="admin-log-search" class="admin-input" placeholder="Search msg + ctx" aria-label="Search log text" />
        <label class="admin-checkbox">
          <input type="checkbox" id="admin-log-tail" ${_state.liveTail ? 'checked' : ''} />
          Live tail
        </label>
        <label class="admin-checkbox" title="Capture DEBUG entries too (default INFO). Persists for this browser session.">
          <input type="checkbox" id="admin-log-debug" ${activeLevel() === 'DEBUG' ? 'checked' : ''} />
          Capture DEBUG
        </label>
        <button id="admin-log-copy" class="admin-btn" type="button">Copy JSON</button>
        <button id="admin-log-clear" class="admin-btn admin-btn--danger" type="button">Clear</button>
      </div>
      <div class="admin-log-scroller">
        <table class="admin-log-table">
          <thead>
            <tr><th>Time</th><th>Level</th><th>Module</th><th>Message</th></tr>
          </thead>
          <tbody id="admin-log-tbody"></tbody>
        </table>
      </div>
      <div class="admin-log-meta" id="admin-log-meta"></div>
    `;

    host.querySelector('#admin-log-level').addEventListener('change', (e) => {
      _state.levelFilter = e.target.value;
      _renderTable(host);
    });
    host.querySelector('#admin-log-module').addEventListener('change', (e) => {
      _state.moduleFilter = e.target.value;
      _renderTable(host);
    });
    host.querySelector('#admin-log-search').addEventListener('input', (e) => {
      _state.textFilter = e.target.value;
      _renderTable(host);
    });
    host.querySelector('#admin-log-tail').addEventListener('change', (e) => {
      _state.liveTail = e.target.checked;
      if (_state.liveTail) _renderTable(host);
    });
    host.querySelector('#admin-log-debug').addEventListener('change', (e) => {
      setActiveLevel(e.target.checked ? 'DEBUG' : 'INFO');
    });
    host.querySelector('#admin-log-copy').addEventListener('click', () => {
      const payload = JSON.stringify(_filtered(), null, 2);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(payload);
        } else {
          const ta = document.createElement('textarea');
          ta.value = payload; document.body.appendChild(ta); ta.select();
          document.execCommand && document.execCommand('copy');
          ta.remove();
        }
      } catch { /* clipboard blocked; fall through */ }
    });
    host.querySelector('#admin-log-clear').addEventListener('click', () => {
      if (!confirm('Clear the local log buffer for this session?')) return;
      clearLogs();
      _refreshModuleOptions(host);
      _renderTable(host);
    });
  }

  // Wire the live-tail subscription each time the tab activates. Unsub on
  // re-activation so we do not stack duplicate subscribers across tab
  // switches -- the ring buffer's subscribe API supports many listeners
  // but a leak here would fire N renders per push after N activations.
  if (_state.unsub) _state.unsub();
  _state.unsub = subscribeLog(() => {
    if (!_state.liveTail && !_state.textFilter && !_state.levelFilter && !_state.moduleFilter) {
      // No filters active + tail off means the user is inspecting a
      // frozen snapshot; do not redraw underneath them.
      _refreshModuleOptions(host);
      _renderTable(host);
      return;
    }
    _refreshModuleOptions(host);
    _renderTable(host);
  });

  _refreshModuleOptions(host);
  _renderTable(host);
}
