// Admin analytics component: search API performance (#434 followup).
// Renders into a container the caller passes in. Handles its own fetch
// + error state so it doesn't block the main analytics render.
//
// Sections:
//  - Headline stats (total requests, unique queries, avg latency, hidden counts)
//  - Latency percentiles (p50/p95/p99/max, last 24h)
//  - Hourly bar chart (last 24h request volume + error overlay)
//  - Top queries table
//  - Top zero-hit queries table (searches that returned nothing -- content gap signal)
//  - Status breakdown (ok / error / ratelimit)
//
// Data source: fetchSearchAnalytics() -> admin_search_analytics RPC.

import { escapeHtml } from '../utils.js?v=2668b2f0';
import { fetchSearchAnalytics } from '../api/search-analytics.js?v=8393e332';

function _num(n) { return Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '0'; }
function _ms(n) { return Number.isFinite(Number(n)) ? `${Number(n).toFixed(0)}ms` : '-'; }

function _totalsHtml(t) {
  if (!t) return '<p class="admin-empty">No search activity in this window.</p>';
  return `
    <div class="analytics-stat-grid">
      <div class="analytics-stat"><div class="analytics-stat-value">${_num(t.total)}</div><div class="analytics-stat-label">Total requests</div></div>
      <div class="analytics-stat"><div class="analytics-stat-value">${_num(t.unique_queries)}</div><div class="analytics-stat-label">Unique queries</div></div>
      <div class="analytics-stat"><div class="analytics-stat-value">${_ms(t.avg_took_ms)}</div><div class="analytics-stat-label">Avg latency</div></div>
      <div class="analytics-stat"><div class="analytics-stat-value">${_num(t.zero_hit_count)}</div><div class="analytics-stat-label">Zero-hit responses</div></div>
      <div class="analytics-stat"><div class="analytics-stat-value">${_num(t.total_hidden_delisted)}</div><div class="analytics-stat-label">Delisted hidden</div></div>
      <div class="analytics-stat"><div class="analytics-stat-value">${_num(t.total_hidden_adult)}</div><div class="analytics-stat-label">Adult hidden</div></div>
    </div>`;
}

function _percentilesHtml(p) {
  if (!p || (!p.p50 && !p.p95 && !p.p99)) {
    return '<p class="admin-empty">No latency data in the last 24h.</p>';
  }
  return `
    <div class="analytics-stat-grid">
      <div class="analytics-stat"><div class="analytics-stat-value">${_ms(p.p50)}</div><div class="analytics-stat-label">p50 (24h)</div></div>
      <div class="analytics-stat"><div class="analytics-stat-value">${_ms(p.p95)}</div><div class="analytics-stat-label">p95 (24h)</div></div>
      <div class="analytics-stat"><div class="analytics-stat-value">${_ms(p.p99)}</div><div class="analytics-stat-label">p99 (24h)</div></div>
      <div class="analytics-stat"><div class="analytics-stat-value">${_ms(p.max)}</div><div class="analytics-stat-label">Max (24h)</div></div>
    </div>`;
}

function _byHourChartHtml() {
  return `<div class="analytics-chart-wrap"><canvas id="search-analytics-hourly-chart" height="150"></canvas></div>`;
}

function _queriesTableHtml(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '<p class="admin-empty">No queries in this window.</p>';
  }
  const showLatency = opts.showLatency !== false;
  return `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Query</th>
          <th style="text-align:right">Requests</th>
          ${opts.showResults ? '<th style="text-align:right">Avg results</th>' : ''}
          ${showLatency ? '<th style="text-align:right">Avg latency</th>' : ''}
          ${opts.zeroHit ? '<th style="text-align:right">Attempts</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><code>${escapeHtml(r.query || '')}</code></td>
            <td style="text-align:right">${_num(r.requests || r.attempts)}</td>
            ${opts.showResults ? `<td style="text-align:right">${(Number(r.avg_results) || 0).toFixed(1)}</td>` : ''}
            ${showLatency ? `<td style="text-align:right">${_ms(r.avg_took_ms)}</td>` : ''}
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function _statusHtml(s) {
  if (!s || Object.keys(s).length === 0) return '<p class="admin-empty">No status data.</p>';
  const total = Object.values(s).reduce((a, b) => a + (Number(b) || 0), 0);
  return `
    <div class="analytics-stat-grid">
      ${Object.entries(s).map(([k, v]) => {
        const pct = total ? Math.round((Number(v) / total) * 100) : 0;
        return `<div class="analytics-stat"><div class="analytics-stat-value">${_num(v)}<span style="font-size:0.6em;opacity:0.7"> (${pct}%)</span></div><div class="analytics-stat-label">${escapeHtml(k)}</div></div>`;
      }).join('')}
    </div>`;
}

async function _drawHourlyChart(byHour) {
  if (!Array.isArray(byHour) || byHour.length === 0) return;
  const canvas = document.getElementById('search-analytics-hourly-chart');
  if (!canvas || typeof window.Chart !== 'function') return;
  // Chart.js is already loaded by the analytics tab; if it's not present
  // we skip silently rather than pull it in a second time.
  const labels = byHour.map(h => new Date(h.hour).toLocaleTimeString(undefined, { hour: '2-digit' }));
  const requests = byHour.map(h => Number(h.requests) || 0);
  const errors = byHour.map(h => Number(h.errors) || 0);
  new window.Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Requests', data: requests, backgroundColor: '#5c8bd6' },
        { label: 'Errors',   data: errors,   backgroundColor: '#c85050' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: { x: { stacked: false }, y: { beginAtZero: true } },
    },
  });
}

export async function renderSearchAnalytics(container, session, { daysBack = 7 } = {}) {
  if (!container) return;
  container.innerHTML = '<div class="admin-loading">Loading search analytics...</div>';
  try {
    const data = await fetchSearchAnalytics(session, { daysBack });
    container.innerHTML = `
      <div class="analytics-section-title" style="margin-top:24px">Search API activity (last ${daysBack}d)</div>
      ${_totalsHtml(data.totals)}
      <div class="analytics-section-title" style="margin-top:20px">Latency percentiles</div>
      ${_percentilesHtml(data.percentiles_24h)}
      <div class="analytics-section-title" style="margin-top:20px">Requests per hour (last 24h)</div>
      ${_byHourChartHtml()}
      <div class="analytics-two-col" style="margin-top:20px">
        <div>
          <div class="analytics-section-title">Top queries</div>
          ${_queriesTableHtml(data.top_queries, { showResults: true })}
        </div>
        <div>
          <div class="analytics-section-title">Zero-hit queries (content gaps)</div>
          ${_queriesTableHtml(data.top_zero_hit, { zeroHit: true, showLatency: false })}
        </div>
      </div>
      <div class="analytics-section-title" style="margin-top:20px">Status breakdown</div>
      ${_statusHtml(data.status_breakdown)}
    `;
    await _drawHourlyChart(data.by_hour);
  } catch (e) {
    container.innerHTML = `<div class="admin-error">Failed to load search analytics: ${escapeHtml(e.message || String(e))}</div>`;
  }
}
