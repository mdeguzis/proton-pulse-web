import { escapeHtml } from '../utils.js?v=86489fcb';

let chartInstance = null;

function destroyChart() {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}

function renderDayButtons(daysBack, onChangeDays) {
  return [7, 30, 90].map(d => {
    const active = d === daysBack ? ' admin-btn--active' : '';
    return `<button class="admin-btn admin-btn--sm${active}" data-days="${d}">${d}d</button>`;
  }).join('');
}

function renderStatCards(totals) {
  const stats = [
    { label: 'Events', value: totals.total_events ?? 0 },
    { label: 'Sessions', value: totals.total_sessions ?? 0 },
    { label: 'Authed users', value: totals.authed_users ?? 0 },
    { label: 'Auth success', value: totals.auth_success ?? 0 },
    { label: 'Auth failure', value: totals.auth_failure ?? 0 },
  ];
  return `<div class="analytics-stats">${stats.map(s =>
    `<div class="analytics-stat">
      <div class="analytics-stat-value">${escapeHtml(String(s.value))}</div>
      <div class="analytics-stat-label">${escapeHtml(s.label)}</div>
    </div>`
  ).join('')}</div>`;
}

function renderPagesTable(rows) {
  if (!rows || !rows.length) return `<p class="admin-empty">No data yet.</p>`;
  const trs = rows.map(r =>
    `<tr><td>${escapeHtml(r.page || '(unknown)')}</td><td>${escapeHtml(String(r.views))}</td></tr>`
  ).join('');
  return `<table class="admin-table">
    <thead><tr><th>Page</th><th>Views</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
}

function renderEventTypesTable(rows) {
  if (!rows || !rows.length) return `<p class="admin-empty">No data yet.</p>`;
  const trs = rows.map(r =>
    `<tr><td>${escapeHtml(r.event_type)}</td><td>${escapeHtml(String(r.total))}</td></tr>`
  ).join('');
  return `<table class="admin-table">
    <thead><tr><th>Event type</th><th>Total</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
}

export function renderAnalytics(data, { daysBack, onChangeDays }) {
  const content = document.getElementById('analytics-content');

  content.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
      <span style="color:var(--text-muted,#888);font-size:0.85rem;">Range:</span>
      ${renderDayButtons(daysBack, onChangeDays)}
    </div>
    ${renderStatCards(data.totals || {})}
    <div class="analytics-chart-wrap">
      <canvas id="analytics-daily-chart"></canvas>
    </div>
    <div class="analytics-two-col">
      <div>
        <div class="analytics-section-title">Top pages</div>
        ${renderPagesTable(data.top_pages)}
      </div>
      <div>
        <div class="analytics-section-title">Event breakdown</div>
        ${renderEventTypesTable(data.event_types)}
      </div>
    </div>
  `;

  content.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener('click', () => onChangeDays(Number(btn.dataset.days)));
  });

  destroyChart();

  const daily = data.daily || [];
  if (daily.length && typeof Chart !== 'undefined') {
    const canvas = document.getElementById('analytics-daily-chart');
    if (canvas) {
      chartInstance = new Chart(canvas, {
        type: 'line',
        data: {
          labels: daily.map(r => r.day),
          datasets: [{
            data: daily.map(r => r.sessions),
            borderColor: '#5c8bd6',
            backgroundColor: 'rgba(92,139,214,0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          }],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#888', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
          },
        },
      });
    }
  }
}
