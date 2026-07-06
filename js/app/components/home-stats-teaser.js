// home-stats-teaser.js -- compact "compatibility at a glance" card for the
// home page (#210, umbrella #204).
//
// Reads stats.json (the same aggregate the /stats page uses) and renders a
// single-row card with the three numbers that matter most (rated share,
// platinum rate, borked rate) plus a "See full stats" link straight into
// the Overall tab of the redesigned stats page. No filters. Small.
//
// The reshape function is pure so the tests can exercise it without a fetch.

import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';

function _fmtPct(num, den) {
  if (!den || den <= 0) return null;
  return Math.round((num / den) * 1000) / 10;
}
function _fmtInt(n) {
  if (n == null || Number.isNaN(n)) return '-';
  return Number(n).toLocaleString();
}

/**
 * Distill stats.json into the four numbers the teaser needs.
 * Returned as strings when they should be rendered, or null when unknown.
 */
export function summarizeStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const total = Number(stats.total_reports || 0);
  if (total <= 0) return null;
  const games = Number(stats.total_games || 0);
  const platinum = Number(stats.by_rating?.platinum || 0);
  const gold     = Number(stats.by_rating?.gold || 0);
  const silver   = Number(stats.by_rating?.silver || 0);
  const bronze   = Number(stats.by_rating?.bronze || 0);
  const borked   = Number(stats.by_rating?.borked || 0);
  const ratedSum = platinum + gold + silver + bronze + borked;
  return {
    totalReports: total,
    totalGames:   games || null,
    ratedShare:   _fmtPct(ratedSum, total),
    platinumPct:  _fmtPct(platinum, total),
    borkedPct:    _fmtPct(borked, total),
  };
}

/**
 * Render the teaser card into the given host element. Returns a promise that
 * resolves when the fetch + render is done. Safe to call multiple times --
 * later calls replace the previous DOM.
 */
export async function renderHomeStatsTeaser(host) {
  if (!host) return;
  host.innerHTML = '';
  let stats = null;
  try {
    const url = await dataUrl('stats.json');
    const resp = await fetch(url);
    if (resp.ok) stats = await resp.json();
  } catch { /* offline / not deployed yet -- render nothing */ }

  const s = summarizeStats(stats);
  if (!s) { host.innerHTML = ''; return; } // stay quiet when there's no data

  host.innerHTML = `
    <a class="home-stats-teaser" href="stats.html#tab=overall" aria-label="See full stats">
      <div class="home-stats-teaser__head">
        <span class="home-stats-teaser__title">Compatibility at a glance</span>
        <span class="home-stats-teaser__cta">See full stats -&gt;</span>
      </div>
      <div class="home-stats-teaser__row">
        <div class="home-stats-teaser__stat">
          <span class="home-stats-teaser__label">Reports</span>
          <span class="home-stats-teaser__value">${_fmtInt(s.totalReports)}</span>
          ${s.totalGames ? `<span class="home-stats-teaser__hint">across ${_fmtInt(s.totalGames)} games</span>` : ''}
        </div>
        ${s.platinumPct != null ? `
          <div class="home-stats-teaser__stat">
            <span class="home-stats-teaser__label">Platinum</span>
            <span class="home-stats-teaser__value home-stats-teaser__value--good">${s.platinumPct}%</span>
            <span class="home-stats-teaser__hint">of reports</span>
          </div>` : ''}
        ${s.borkedPct != null ? `
          <div class="home-stats-teaser__stat">
            <span class="home-stats-teaser__label">Borked</span>
            <span class="home-stats-teaser__value home-stats-teaser__value--bad">${s.borkedPct}%</span>
            <span class="home-stats-teaser__hint">of reports</span>
          </div>` : ''}
      </div>
    </a>`;
}
