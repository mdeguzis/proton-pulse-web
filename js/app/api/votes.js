// votes (api) for the app page. Relocated from app.js.

import { getWebClientId } from '../../shared/submit.js?v=0c76eadb';
import { clientWrite } from '../../shared/client-key.js?v=2d558d2f';
import { SB_KEY, SB_URL } from '../config.js?v=7873e060';

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
    await saveVote(appId, rKey, 0, 'Could not update your vote.');
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

  await saveVote(appId, rKey, vote, 'Could not save your vote.');
}

// Votes are signed with this browser's non-extractable key and sent to the
// client-write edge function (#62). 1 / -1 sets the vote, 0 clears it.
async function saveVote(appId, rKey, vote, failMsg) {
  try {
    const r = await clientWrite(SB_URL, SB_KEY, getWebClientId(), 'cast_vote', {
      app_id: String(appId), report_key: rKey, vote,
    });
    if (!r.ok) {
      console.warn('[castVote] client-write cast_vote failed', { appId: String(appId), rKey, vote, status: r.status, error: r.data?.error });
      window.ppToast?.error(`${failMsg} Try again later.`);
    }
  } catch (err) {
    console.warn('[castVote] client-write network error', { appId: String(appId), rKey, vote, error: String(err) });
    window.ppToast?.error(`${failMsg} Check your connection.`);
  }
}

// - Helpers ------------------------------------------
