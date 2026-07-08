/**
 * #237: metadata modal renders a "Tracked since" column and a brown
 * package-icon link to the per-game depots.json we publish under
 * data/{appId}/. Also pins the steam-depot-info edge fn contract:
 * both current updates and observation history are queried, tracked_since
 * only fires from real first_observed_at rows, and the response drops the
 * old misleading `first_seen` field.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const EDGE = read('supabase/functions/steam-depot-info/index.ts');
const COMP = read('js/app/components/game-page.js');
const CSS  = read('css/app/game-header.css');
const WRITER = read('scripts/pipeline/write_depot_files.py');
const FINAL  = read('scripts/pipeline/finalize.py');
const MIG    = read('supabase/migrations/20260708080000_steam_depot_raw_pics.sql');

describe('#237: steam-depot-info edge fn returns tracked_since', () => {
  test('queries both current updates AND manifest history', () => {
    expect(EDGE).toContain('.from("steam_depot_updates")');
    expect(EDGE).toContain('.from("steam_depot_manifest_history")');
    // Both queries fire in parallel so an app-wide fetch is one round-trip.
    expect(EDGE).toContain('await Promise.all(');
  });

  test('exposes tracked_since per OS from earliest first_observed_at', () => {
    expect(EDGE).toContain('tracked_since:');
    expect(EDGE).toContain('first_observed_at');
    expect(EDGE).toContain('trackedSince: number | null');
    // We deliberately never fall back to last_updated for tracked_since --
    // better to return null than lie.
    expect(EDGE).toContain('tracked_since: b.trackedSince != null');
  });

  test('drops the misleading first_seen field from the response', () => {
    // Old shape had first_seen derived from min(last_updated_at) which was
    // wrong -- it's just the earliest depot last-update, not observation.
    expect(EDGE).not.toContain('first_seen:');
  });

  test('history query failure is soft -- current updates alone are still served', () => {
    expect(EDGE).toContain('history query soft-failed');
    expect(EDGE).toContain('console.warn');
  });
});

describe('#237: metadata modal wires tracked_since + depot file icon', () => {
  test('renders a 4-column table with Depots as the icon-only last column', () => {
    // #237 v2: Depots moved to the right so mobile can collapse it to just
    // the icon without pushing the important date columns off-screen.
    expect(COMP).toContain('<th>OS</th><th>Tracked since</th><th>Last update</th><th class="gm-plat-depots-th">Depots</th>');
    // Footer colspan matches the column count.
    expect(COMP).toContain('colspan="4"');
  });

  test('depots cell is icon-only (no "N tracked" text) with count in the tooltip', () => {
    // Old cell had `${cached.depots} tracked` visible text; new cell inlines
    // the icon directly and puts the count in the title attribute.
    expect(COMP).toContain('gm-plat-depots');
    expect(COMP).not.toContain('${cached.depots} tracked');
    expect(COMP).toMatch(/\$\{cached\.depots\} depot\$\{cached\.depots !== 1 \? 's' : ''\} tracked/);
  });

  test('footer explains that tracked-since is our observation floor, not the historical add-date', () => {
    // Users kept asking "why isn't this the date macOS was added?" -- spell
    // out that PICS doesn't expose depot creation dates.
    expect(COMP).toContain("not the historical date the OS build was added");
    expect(COMP).toContain("Newly-added OS builds");
  });

  test('formats tracked_since from cached.tracked_since', () => {
    expect(COMP).toContain('const trackedFmt = fmtDate(cached?.tracked_since)');
    // Tooltip explains the field is our observation floor, not a historical
    // add-date -- prevents users from misreading it as "when Mac was added".
    expect(COMP).toContain('Earliest observation date we recorded');
  });

  test('brown package icon links to the gh-pages depots.json blob', () => {
    expect(COMP).toContain('gm-depot-file');
    expect(COMP).toContain('/blob/gh-pages/data/${esc(String(meta.appId))}/depots.json');
    // Deep-links to the OS anchor so we can scroll to a specific block later.
    expect(COMP).toContain('#os=${esc(key)}');
    // Package icon markup lives in an inline SVG so we don't need a new asset.
    expect(COMP).toContain('<svg viewBox="0 0 24 24"');
  });

  test('icon has its own CSS class with the brown Steam-package palette', () => {
    expect(CSS).toContain('.gm-depot-file {');
    // Palette matches the existing bronze tier accent so it reads as
    // "packaging" without introducing a new site color.
    expect(CSS).toContain('color: #b07040');
  });
});

describe('#237: pipeline emits per-game depots.json during finalize', () => {
  test('finalize.py imports and calls write_depot_files', () => {
    expect(FINAL).toContain('from .write_depot_files import write_depot_files');
    expect(FINAL).toContain('write_depot_files(data_output_path)');
  });

  test('writer emits one file per Steam app under {appId}/depots.json', () => {
    expect(WRITER).toContain('app_dir = base / app_id_to_dir(str(app_id))');
    expect(WRITER).toContain('"depots.json"');
  });

  test('writer pulls raw_pics + tracked_since + manifests from Supabase', () => {
    expect(WRITER).toContain('steam_depot_updates');
    expect(WRITER).toContain('steam_depot_manifest_history');
    expect(WRITER).toContain('steam_depot_fetch_status');
    expect(WRITER).toContain('raw_pics');
    expect(WRITER).toContain('tracked_since');
  });
});

describe('#237: migration adds raw_pics jsonb column', () => {
  test('adds a jsonb column on steam_depot_fetch_status', () => {
    expect(MIG).toContain('alter table public.steam_depot_fetch_status');
    expect(MIG).toContain('add column if not exists raw_pics jsonb');
  });
});
