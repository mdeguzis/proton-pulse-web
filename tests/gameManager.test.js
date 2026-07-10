/**
 * #234: Game Manager admin panel -- API client + component wiring.
 *
 * The MVP writes hides + remaps to Supabase and shows a read-only view
 * of the pipeline suspect list from app-id-redirects.json. Frontend
 * enforcement (search filter, redirect on remap) is a follow-up ticket;
 * this test file pins the admin write path + the UI contract that goes
 * with it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MIG   = read('supabase/migrations/20260708100000_game_manager_tables.sql');
const PERMS = read('js/admin/permissions.js');
const API   = read('js/admin/api/gameManager.js');
const COMP  = read('js/admin/components/gameManager.js');
const HTML  = read('admin.html');
const MAIN  = read('js/admin/main.js');
const MANIF = read('gh-pages-manifest.txt').split('\n').map((l) => l.trim());

describe('#234: migration adds game_hides + game_remaps + manage_games perm', () => {
  test('creates both tables keyed on app_id / from_app_id', () => {
    expect(MIG).toContain('CREATE TABLE IF NOT EXISTS public.game_hides');
    expect(MIG).toContain('app_id      TEXT PRIMARY KEY');
    expect(MIG).toContain('CREATE TABLE IF NOT EXISTS public.game_remaps');
    expect(MIG).toContain('from_app_id  TEXT PRIMARY KEY');
    expect(MIG).toContain('to_app_id    TEXT NOT NULL');
  });

  test('game_remaps blocks self-loops via CHECK constraint', () => {
    expect(MIG).toContain('game_remaps_no_self_loop CHECK (from_app_id <> to_app_id)');
  });

  test('RLS gates writes on manage_games; reads are public', () => {
    // Both tables must permit public SELECT (pipeline + frontend read them).
    expect(MIG).toMatch(/anyone can read game_hides/);
    expect(MIG).toMatch(/anyone can read game_remaps/);
    // Writes are gated on the new permission for both tables.
    const gates = MIG.match(/current_user_has_permission\('manage_games'\)/g) || [];
    // 3 policies (insert/update/delete) x 2 tables = 6 permission checks.
    expect(gates.length).toBeGreaterThanOrEqual(6);
  });

  test('backfills existing moderators with manage_games', () => {
    expect(MIG).toContain('array_append(permissions, \'manage_games\')');
    expect(MIG).toContain('role = \'moderator\'');
  });
});

describe('#234: frontend permission vocabulary + tab gating', () => {
  test('permissions.js registers manage_games and gates the games tab on it', () => {
    expect(PERMS).toContain("{ key: 'manage_games'");
    expect(PERMS).toContain('Manage games (hide / remap)');
    // Tab gate lives in TAB_PERMISSIONS so canSeeTab returns false without the perm.
    expect(PERMS).toContain("games:          ['manage_games']");
    // Moderator preset should get it so a fresh moderator has access.
    expect(PERMS).toContain("moderator:   ['manage_reports', 'delete_reports', 'ban_users', 'view_analytics', 'manage_games']");
  });

  test('admin.html declares the tab + section', () => {
    expect(HTML).toContain('<option value="games">Game Manager</option>');
    expect(HTML).toContain('id="tab-games"');
    expect(HTML).toContain('id="game-manager-content"');
  });

  test('main.js registers the tab loader with the render function', () => {
    expect(MAIN).toContain("import { renderGameManager }");
    expect(MAIN).toContain("games: () => renderGameManager()");
  });

  test('gh-pages manifest lists both new client files', () => {
    expect(MANIF).toContain('js/admin/api/gameManager.js');
    expect(MANIF).toContain('js/admin/components/gameManager.js');
  });
});

describe('#234: API client uses PostgREST with merge-duplicates upserts', () => {
  test('upsertGameHide posts to game_hides with on_conflict=app_id', () => {
    expect(API).toContain('export async function upsertGameHide');
    expect(API).toContain('/game_hides?on_conflict=app_id');
    expect(API).toContain("Prefer: 'resolution=merge-duplicates,return=representation'");
  });

  test('upsertGameRemap posts to game_remaps with on_conflict=from_app_id + self-loop guard', () => {
    expect(API).toContain('export async function upsertGameRemap');
    expect(API).toContain('/game_remaps?on_conflict=from_app_id');
    // Panel-side self-loop check so the error message is human-friendly
    // instead of a raw CHECK constraint violation.
    expect(API).toContain('from and to app ids must differ');
  });

  test('delete helpers scope to the primary key via .eq filter', () => {
    expect(API).toContain('/game_hides?app_id=eq.${encodeURIComponent');
    expect(API).toContain('/game_remaps?from_app_id=eq.${encodeURIComponent');
  });

  test('loadPipelineSuspects fetches app-id-redirects.json off the current origin', () => {
    // Path resolution must respect the staging repo prefix so the panel
    // still works on both mdeguzis.github.io/proton-pulse-web(-staging).
    expect(API).toContain("proton-pulse-web-staging");
    expect(API).toContain("app-id-redirects.json");
  });

  test('requires reason on both writers so RLS never sees an empty string', () => {
    // Server-side has NOT NULL on `reason`; catching it client-side gives
    // the admin a real error message before the round trip.
    expect(API).toContain('reason are required');
    expect(API).toContain("reason?.trim()");
  });
});

describe('#234: component renders three sections + wires row actions', () => {
  test('renders forms for hide + remap and a suspects panel', () => {
    expect(COMP).toContain('id="gm-hide-form"');
    expect(COMP).toContain('id="gm-remap-form"');
    expect(COMP).toContain('Pipeline-flagged suspects');
  });

  test('promote-remap and promote-hide buttons target the suspects rows', () => {
    // These are the "one-click promote" buttons on the suspects table that
    // seed a real hide/remap from the pipeline flag.
    expect(COMP).toContain("data-action=\"promote-remap\"");
    expect(COMP).toContain("data-action=\"promote-hide\"");
  });

  test('unhide + clear-remap use delegated row actions so re-render stays cheap', () => {
    expect(COMP).toContain("data-action=\"unhide\"");
    expect(COMP).toContain("data-action=\"clear-remap\"");
    // Single event delegate on the panel root handles all row actions.
    expect(COMP).toContain("el.addEventListener('click'");
  });

  test('title map from search-index is used to render titles alongside raw ids', () => {
    expect(COMP).toContain('_titleMap()');
    expect(COMP).toContain("dataUrl('search-index.json')");
  });
});
