// Library + Wishlist section: shows the cached Steam library game count
// with a REFRESH button that re-runs the sync-steam-library edge
// function (#199) and, alongside it, the same shape for the user's
// Steam wishlist (#266). Each card also shows a per-type breakdown
// (game / dlc / demo / mod / ...) computed against the pipeline's
// steam-type-cache.json so users can see what's actually in their
// collection at a glance.
import { SupaAuth } from '../config.js?v=87cd0f3d';
import { formatSystemUpdated, escapeHtml } from '../utils.js?v=78ac95ab';
import { fetchMyLibraryRow, syncMyLibrary } from '../api/steam-library.js?v=d03f2631';
import { fetchMyWishlistRow, syncMyWishlist } from '../api/steam-wishlist.js?v=989d8088';
import { computeTypeBreakdown } from '../lib/steam-type-breakdown.js?v=c6959bfe';

function _renderTypesLine(el, breakdown) {
  if (!el) return;
  if (!breakdown || breakdown.total === 0) { el.hidden = true; el.textContent = ''; return; }
  // Show every non-zero bucket in descending order. "unknown" reads as
  // "not yet cached" because the enricher is still filling in ~35k apps
  // (#258 / #261); the phrasing avoids implying data is missing.
  const parts = breakdown.order.map(([type, n]) => {
    const label = type === 'unknown' ? 'not yet cached' : type;
    return `${n.toLocaleString()} ${label}`;
  });
  el.textContent = parts.join(' \u00b7 ');
  el.hidden = false;
}

export function initLibrary(ctx) {
  const {
    libraryCount, libraryStatus, libraryRefresh, libraryEmpty, libraryTypes,
    wishlistCount, wishlistStatus, wishlistRefresh, wishlistEmpty, wishlistTypes,
  } = ctx;

  const libraryOn  = !!(libraryCount && libraryStatus && libraryRefresh);
  const wishlistOn = !!(wishlistCount && wishlistStatus && wishlistRefresh);
  if (!libraryOn && !wishlistOn) return { refreshLibrary: async () => {}, refreshWishlist: async () => {} };

  // ---- Library ---------------------------------------------------------
  function setLibraryEmpty(msg) {
    libraryCount.textContent = '';
    libraryStatus.textContent = '';
    if (libraryEmpty) { libraryEmpty.textContent = msg; libraryEmpty.hidden = false; }
    if (libraryTypes) { libraryTypes.hidden = true; libraryTypes.textContent = ''; }
  }

  async function renderLibraryRow(row, session) {
    if (libraryEmpty) libraryEmpty.hidden = true;
    const nick = session?.user?.user_metadata?.full_name
      || session?.user?.user_metadata?.name
      || 'You';
    const count = Number(row?.game_count) || 0;
    libraryCount.textContent = `${nick}: ${count.toLocaleString()} games`;
    libraryStatus.textContent = row?.synced_at
      ? `Last synced ${formatSystemUpdated(row.synced_at)}`
      : '';
    const appids = Array.isArray(row?.appids) ? row.appids : [];
    if (libraryTypes && appids.length) {
      try {
        const breakdown = await computeTypeBreakdown(appids);
        _renderTypesLine(libraryTypes, breakdown);
      } catch (e) {
        console.debug('[profile] library type breakdown failed', { error: e?.message });
      }
    }
  }

  async function loadLibraryCached() {
    if (!libraryOn) return;
    const session = await SupaAuth.getSession();
    if (!session?.user) { setLibraryEmpty('Sign in with Steam to view your library.'); return; }
    try {
      const row = await fetchMyLibraryRow(session);
      if (row) { await renderLibraryRow(row, session); return; }
      if (libraryEmpty) libraryEmpty.hidden = true;
      libraryStatus.textContent = 'Fetching your Steam library...';
      await syncMyLibrary(session);
      const fresh = await fetchMyLibraryRow(session);
      if (fresh) await renderLibraryRow(fresh, session);
      else setLibraryEmpty('Sync completed but no rows returned. Try Refresh.');
    } catch (e) {
      setLibraryEmpty(`Failed to load library: ${escapeHtml(e.message || 'error')}`);
    }
  }

  async function refreshLibrary() {
    if (!libraryOn) return;
    const session = await SupaAuth.getSession();
    if (!session?.user) { setLibraryEmpty('Sign in with Steam to sync your library.'); return; }
    libraryRefresh.disabled = true;
    const prevLabel = libraryRefresh.textContent;
    libraryRefresh.textContent = 'Syncing...';
    try {
      await syncMyLibrary(session);
      const row = await fetchMyLibraryRow(session);
      await renderLibraryRow(row, session);
      window.ppToast?.success('Library synced.');
    } catch (e) {
      window.ppToast?.error(e.message || 'Sync failed.');
      libraryStatus.textContent = `Sync failed: ${e.message || 'error'}`;
    } finally {
      libraryRefresh.disabled = false;
      libraryRefresh.textContent = prevLabel;
    }
  }

  // ---- Wishlist --------------------------------------------------------
  function setWishlistEmpty(msg) {
    wishlistCount.textContent = '';
    wishlistStatus.textContent = '';
    if (wishlistEmpty) { wishlistEmpty.textContent = msg; wishlistEmpty.hidden = false; }
    if (wishlistTypes) { wishlistTypes.hidden = true; wishlistTypes.textContent = ''; }
  }

  async function renderWishlistRow(row) {
    if (wishlistEmpty) wishlistEmpty.hidden = true;
    const count = Number(row?.item_count) || 0;
    wishlistCount.textContent = count === 0
      ? 'No items on your wishlist yet.'
      : `${count.toLocaleString()} item${count === 1 ? '' : 's'} on wishlist`;
    wishlistStatus.textContent = row?.synced_at
      ? `Last synced ${formatSystemUpdated(row.synced_at)}`
      : '';
    const appids = Array.isArray(row?.appids) ? row.appids : [];
    if (wishlistTypes && appids.length) {
      try {
        const breakdown = await computeTypeBreakdown(appids);
        _renderTypesLine(wishlistTypes, breakdown);
      } catch (e) {
        console.debug('[profile] wishlist type breakdown failed', { error: e?.message });
      }
    }
  }

  async function loadWishlistCached() {
    if (!wishlistOn) return;
    const session = await SupaAuth.getSession();
    if (!session?.user) { setWishlistEmpty('Sign in with Steam to view your wishlist.'); return; }
    try {
      const row = await fetchMyWishlistRow(session);
      if (row) { await renderWishlistRow(row); return; }
      if (wishlistEmpty) wishlistEmpty.hidden = true;
      wishlistStatus.textContent = 'Fetching your Steam wishlist...';
      await syncMyWishlist(session);
      const fresh = await fetchMyWishlistRow(session);
      if (fresh) await renderWishlistRow(fresh);
      else setWishlistEmpty('Sync completed but no rows returned. Try Refresh.');
    } catch (e) {
      setWishlistEmpty(`Failed to load wishlist: ${escapeHtml(e.message || 'error')}`);
    }
  }

  async function refreshWishlist() {
    if (!wishlistOn) return;
    const session = await SupaAuth.getSession();
    if (!session?.user) { setWishlistEmpty('Sign in with Steam to sync your wishlist.'); return; }
    wishlistRefresh.disabled = true;
    const prevLabel = wishlistRefresh.textContent;
    wishlistRefresh.textContent = 'Syncing...';
    try {
      await syncMyWishlist(session);
      const row = await fetchMyWishlistRow(session);
      await renderWishlistRow(row);
      window.ppToast?.success('Wishlist synced.');
    } catch (e) {
      window.ppToast?.error(e.message || 'Sync failed.');
      wishlistStatus.textContent = `Sync failed: ${e.message || 'error'}`;
    } finally {
      wishlistRefresh.disabled = false;
      wishlistRefresh.textContent = prevLabel;
    }
  }

  if (libraryOn)  libraryRefresh.addEventListener('click', refreshLibrary);
  if (wishlistOn) wishlistRefresh.addEventListener('click', refreshWishlist);
  void loadLibraryCached();
  void loadWishlistCached();

  return { refreshLibrary, refreshWishlist, loadLibraryCached, loadWishlistCached };
}
