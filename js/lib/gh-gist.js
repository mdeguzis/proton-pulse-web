/**
 * gh-gist.js — Gist backup/restore for Proton Pulse configs
 *
 * Saves the user's Proton Pulse configs to a private GitHub Gist and
 * can restore them.  Requires a GitHub token with the `gist` scope
 * (obtained via GhAuth.login()).
 */

const GhGist = (() => {
  const API         = 'https://api.github.com';
  const DESCRIPTION = 'Proton Pulse Config Backup';
  const FILENAME    = 'proton-pulse-configs.json';

  function _headers(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /**
   * Find the user's existing Proton Pulse backup Gist, or return null.
   * @param {string} token
   * @returns {Promise<object|null>} Gist object or null
   */
  async function findBackupGist(token) {
    const r = await fetch(`${API}/gists`, { headers: _headers(token) });
    if (!r.ok) throw new Error(`GitHub API error: ${r.status}`);
    const list = await r.json();
    return list.find(g => g.description === DESCRIPTION && g.files?.[FILENAME]) ?? null;
  }

  /**
   * Save configs to the user's backup Gist (creates one if it doesn't exist).
   *
   * @param {string} token       GitHub access token
   * @param {Array}  configs     Array of config objects to save
   * @returns {Promise<object>}  The saved Gist object (includes .html_url)
   */
  async function save(token, configs) {
    const content = JSON.stringify(
      { version: 1, savedAt: new Date().toISOString(), configs },
      null, 2
    );

    const existing = await findBackupGist(token);
    const body = JSON.stringify({
      description: DESCRIPTION,
      public: false,
      files: { [FILENAME]: { content } }
    });

    const r = existing
      ? await fetch(`${API}/gists/${existing.id}`, { method: 'PATCH', headers: _headers(token), body })
      : await fetch(`${API}/gists`,                 { method: 'POST',  headers: _headers(token), body });

    if (!r.ok) throw new Error(`Gist save failed: ${r.status}`);
    return r.json();
  }

  /**
   * Load configs from the user's backup Gist.
   *
   * @param {string} token
   * @returns {Promise<{version, savedAt, configs}|null>}  null if no backup found
   */
  async function load(token) {
    const gist = await findBackupGist(token);
    if (!gist) return null;

    const r = await fetch(`${API}/gists/${gist.id}`, { headers: _headers(token) });
    if (!r.ok) throw new Error(`Gist load failed: ${r.status}`);
    const data = await r.json();
    const raw = data.files?.[FILENAME]?.content;
    if (!raw) return null;
    return JSON.parse(raw);
  }

  /**
   * Load configs from any Gist by ID (e.g. shared by another user).
   * Token is optional — public Gists can be read without auth.
   *
   * @param {string}      gistId
   * @param {string|null} token   Optional access token
   * @returns {Promise<{version, savedAt, configs}>}
   */
  async function loadById(gistId, token = null) {
    const headers = token
      ? _headers(token)
      : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

    const r = await fetch(`${API}/gists/${gistId}`, { headers });
    if (!r.ok) throw new Error(`Gist not found: ${r.status}`);
    const data = await r.json();
    const raw = data.files?.[FILENAME]?.content;
    if (!raw) throw new Error('No Proton Pulse backup data found in this Gist.');
    return JSON.parse(raw);
  }

  return { save, load, loadById, findBackupGist };
})();
