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
    const active = d === daysBack ? ' admin-sort-btn--active' : '';
    return `<button class="admin-sort-btn${active}" data-days="${d}">${d}d</button>`;
  }).join('');
}

function renderStatCards(totals) {
  const stats = [
    { label: 'Events',      value: totals.total_events      ?? 0 },
    { label: 'Sessions',    value: totals.total_sessions    ?? 0 },
    { label: 'Unique users',value: totals.authed_users      ?? 0 },
    { label: 'New users',   value: totals.new_users         ?? 0 },
    { label: 'Logins',      value: totals.auth_success      ?? 0 },
    { label: 'Login fails', value: totals.auth_failure      ?? 0 },
    { label: 'Reports',     value: totals.reports_submitted ?? 0 },
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
  return `<table class="admin-table">
    <thead><tr><th>Page</th><th>Views</th></tr></thead>
    <tbody>${rows.map(r =>
      `<tr><td>${escapeHtml(r.page || '(unknown)')}</td><td>${escapeHtml(String(r.views))}</td></tr>`
    ).join('')}</tbody>
  </table>`;
}

function renderGamesTable(rows) {
  if (!rows || !rows.length) return `<p class="admin-empty">No game views tracked yet.</p>`;
  return `<table class="admin-table">
    <thead><tr><th>Game</th><th>Views</th></tr></thead>
    <tbody>${rows.map(r => {
      const title = escapeHtml(r.title || r.app_id || '(unknown)');
      const link  = r.app_id
        ? `<a class="admin-link" href="/app.html#/app/${escapeHtml(String(r.app_id))}" target="_blank">${title}</a>`
        : title;
      return `<tr><td>${link}</td><td>${escapeHtml(String(r.views))}</td></tr>`;
    }).join('')}</tbody>
  </table>`;
}

function renderEventTypesTable(rows) {
  if (!rows || !rows.length) return `<p class="admin-empty">No data yet.</p>`;
  return `<table class="admin-table">
    <thead><tr><th>Event type</th><th>Total</th></tr></thead>
    <tbody>${rows.map(r =>
      `<tr><td><code style="font-size:0.78rem">${escapeHtml(r.event_type)}</code></td><td>${escapeHtml(String(r.total))}</td></tr>`
    ).join('')}</tbody>
  </table>`;
}

export function renderAnalytics(data, { daysBack, onChangeDays }) {
  const content = document.getElementById('analytics-content');

  content.innerHTML = `
    <div class="admin-sort-row" style="margin-bottom:16px">
      <span class="admin-sort-label">Range:</span>
      ${renderDayButtons(daysBack, onChangeDays)}
    </div>
    ${renderStatCards(data.totals || {})}
    <div style="margin-bottom:6px">
      <span class="analytics-section-title">Daily activity</span>
      <span style="float:right;font-size:0.75rem;color:var(--text-muted,#888)">
        <span style="color:#5c8bd6">&#9644;</span> Sessions &nbsp;
        <span style="color:#4caf80">&#9644;</span> Unique users
      </span>
    </div>
    <div class="analytics-chart-wrap">
      <canvas id="analytics-daily-chart"></canvas>
    </div>
    <div class="analytics-two-col" style="margin-top:20px">
      <div>
        <div class="analytics-section-title">Top pages</div>
        ${renderPagesTable(data.top_pages)}
      </div>
      <div>
        <div class="analytics-section-title">Event breakdown</div>
        ${renderEventTypesTable(data.event_types)}
      </div>
    </div>
    <div style="margin-top:20px">
      <div class="analytics-section-title">Top games viewed</div>
      ${renderGamesTable(data.top_games)}
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
          datasets: [
            {
              label: 'Sessions',
              data: daily.map(r => r.sessions),
              borderColor: '#5c8bd6',
              backgroundColor: 'rgba(92,139,214,0.12)',
              fill: true,
              tension: 0.3,
              pointRadius: 3,
            },
            {
              label: 'Unique users',
              data: daily.map(r => r.unique_users ?? 0),
              borderColor: '#4caf80',
              backgroundColor: 'rgba(76,175,128,0.08)',
              fill: true,
              tension: 0.3,
              pointRadius: 3,
            },
          ],
        },
        options: {
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: items => items[0].label,
              },
            },
          },
          scales: {
            x: { ticks: { color: '#888', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
          },
        },
      });
    }
  }
}
