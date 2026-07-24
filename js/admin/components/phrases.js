// phrases (components) for the admin page.

import { escapeHtml, fmtDateTime } from '../utils.js?v=2668b2f0';

export function renderPhrases(rows) {
  const loading = document.getElementById('phrases-loading');
  const empty   = document.getElementById('phrases-empty');
  const table   = document.getElementById('phrases-table');
  const tbody   = document.getElementById('phrases-tbody');
  const err     = document.getElementById('phrases-error');

  loading.hidden = true;
  err.hidden = true;

  if (!rows.length) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }

  empty.hidden = true;
  table.hidden = false;

  tbody.innerHTML = rows.map(r => {
    const id      = escapeHtml(String(r.id));
    const pattern = escapeHtml(r.pattern);
    const typeTag = r.is_regex
      ? '<span class="admin-badge admin-badge--regex">Regex</span>'
      : '<span class="admin-badge">Literal</span>';
    const desc    = escapeHtml(r.description || '—');
    const added   = escapeHtml(fmtDateTime(r.created_at));
    const toggleLabel = r.enabled ? 'Disable' : 'Enable';
    const toggleClass = r.enabled ? 'admin-btn--warn' : 'admin-btn--ok';
    return `<tr data-phrase-id="${id}"${r.enabled ? '' : ' class="admin-row--disabled"'}>
      <td><code class="admin-pattern">${pattern}</code></td>
      <td>${typeTag}</td>
      <td>${desc}</td>
      <td>${added}</td>
      <td>
        <div class="admin-actions">
          <button class="admin-btn admin-btn--sm ${toggleClass}" data-action="toggle-phrase" data-id="${id}" data-enabled="${r.enabled}">${toggleLabel}</button>
          <button class="admin-btn admin-btn--sm admin-btn--danger" data-action="remove-phrase" data-id="${id}">Remove</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}
