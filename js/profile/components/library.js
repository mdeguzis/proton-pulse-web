// Library section: shows the cached Steam library game count with a REFRESH
// button that re-runs the sync-steam-library edge function (#199).
import { SupaAuth } from '../config.js?v=87cd0f3d';
import { formatSystemUpdated, escapeHtml } from '../utils.js?v=71a515e5';
import { fetchMyLibraryRow, syncMyLibrary } from '../api/steam-library.js?v=d03f2631';

export function initLibrary(ctx) {
  const { libraryCount, libraryStatus, libraryRefresh, libraryEmpty } = ctx;
  if (!libraryCount || !libraryStatus || !libraryRefresh) return { refreshLibrary: async () => {} };

  function setEmpty(msg) {
    libraryCount.textContent = '';
    libraryStatus.textContent = '';
    if (libraryEmpty) {
      libraryEmpty.textContent = msg;
      libraryEmpty.hidden = false;
    }
  }

  function renderRow(row, session) {
    if (libraryEmpty) libraryEmpty.hidden = true;
    const nick = session?.user?.user_metadata?.full_name
      || session?.user?.user_metadata?.name
      || 'You';
    const count = Number(row?.game_count) || 0;
    libraryCount.textContent = `${nick}: ${count.toLocaleString()} games`;
    libraryStatus.textContent = row?.synced_at
      ? `Last synced ${formatSystemUpdated(row.synced_at)}`
      : '';
  }

  async function loadCached() {
    const session = await SupaAuth.getSession();
    if (!session?.user) {
      setEmpty('Sign in with Steam to view your library.');
      return;
    }
    try {
      const row = await fetchMyLibraryRow(session);
      if (row) {
        renderRow(row, session);
        return;
      }
      // First visit after sign-in: auto-sync so users don't have to press
      // Refresh to see anything (#199).
      if (libraryEmpty) libraryEmpty.hidden = true;
      libraryStatus.textContent = 'Fetching your Steam library...';
      await syncMyLibrary(session);
      const fresh = await fetchMyLibraryRow(session);
      if (fresh) renderRow(fresh, session);
      else setEmpty('Sync completed but no rows returned. Try Refresh.');
    } catch (e) {
      setEmpty(`Failed to load library: ${escapeHtml(e.message || 'error')}`);
    }
  }

  async function refreshLibrary() {
    const session = await SupaAuth.getSession();
    if (!session?.user) {
      setEmpty('Sign in with Steam to sync your library.');
      return;
    }
    libraryRefresh.disabled = true;
    const prevLabel = libraryRefresh.textContent;
    libraryRefresh.textContent = 'Syncing...';
    try {
      await syncMyLibrary(session);
      const row = await fetchMyLibraryRow(session);
      renderRow(row, session);
      window.ppToast?.success('Library synced.');
    } catch (e) {
      window.ppToast?.error(e.message || 'Sync failed.');
      libraryStatus.textContent = `Sync failed: ${e.message || 'error'}`;
    } finally {
      libraryRefresh.disabled = false;
      libraryRefresh.textContent = prevLabel;
    }
  }

  libraryRefresh.addEventListener('click', refreshLibrary);
  void loadCached();

  return { refreshLibrary, loadCached };
}
