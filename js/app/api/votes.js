// votes (api) for the app page. Relocated from app.js.

import { getWebClientId } from '../../shared/submit.js?v=93ece6c4';
import { SB_KEY, SB_URL } from '../config.js?v=f9591262';

export async function fetchVotes(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/report_vote_totals?app_id=eq.${appId}&select=report_key,upvotes,downvotes`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return {};
    const rows = await r.json();
    const totals = {};
    for (const v of rows) {
      totals[v.report_key] = { up: Number(v.upvotes || 0), down: Number(v.downvotes || 0) };
    }
    return totals;
  } catch { return {}; }
}

export async function fetchUserVotes(appId) {
  try {
    const voterId = getWebClientId();
    if (!voterId) return {};
    const r = await fetch(
      `${SB_URL}/report_votes?voter_id=eq.${voterId}&app_id=eq.${appId}&select=report_key,vote`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return {};
    const rows = await r.json();
    const result = {};
    for (const row of rows) result[row.report_key] = row.vote;
    return result;
  } catch { return {}; }
}

export async function castVote(appId, rKey, vote, upBtn, dnBtn) {
  const voterId = getWebClientId();
  const wasUp = upBtn.classList.contains('active');
  const wasDn = dnBtn.classList.contains('active');
  const upCount = upBtn.querySelector('.vote-count');
  const dnCount = dnBtn.querySelector('.vote-count');
  const up = parseInt(upCount.textContent) || 0;
  const dn = parseInt(dnCount.textContent) || 0;

  const isUndo = (vote === 1 && wasUp) || (vote === -1 && wasDn);

  upBtn.classList.remove('active');
  dnBtn.classList.remove('active');

  if (isUndo) {
    if (vote === 1) upCount.textContent = Math.max(0, up - 1);
    else dnCount.textContent = Math.max(0, dn - 1);
    try {
      await fetch(`${SB_URL}/report_votes?voter_id=eq.${voterId}&app_id=eq.${String(appId)}&report_key=eq.${encodeURIComponent(rKey)}`, {
        method: 'DELETE',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'return=minimal' },
      });
    } catch { window.ppToast?.error('Could not update your vote. Check your connection.'); }
    return;
  }

  if (vote === 1) {
    upBtn.classList.add('active');
    upCount.textContent = up + 1;
    if (wasDn) dnCount.textContent = Math.max(0, dn - 1);
  } else {
    dnBtn.classList.add('active');
    dnCount.textContent = dn + 1;
    if (wasUp) upCount.textContent = Math.max(0, up - 1);
  }

  try {
    const existing = wasUp ? 1 : wasDn ? -1 : null;
    if (existing === null) {
      await fetch(`${SB_URL}/report_votes?on_conflict=voter_id,app_id,report_key`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ voter_id: voterId, app_id: String(appId), report_key: rKey, vote }),
      });
    } else {
      await fetch(`${SB_URL}/report_votes?voter_id=eq.${voterId}&app_id=eq.${String(appId)}&report_key=eq.${encodeURIComponent(rKey)}`, {
        method: 'PATCH',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ vote }),
      });
    }
  } catch { window.ppToast?.error('Could not save your vote. Check your connection.'); }
}

// - Helpers ------------------------------------------
