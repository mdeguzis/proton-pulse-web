/**
 * #545: "HITMAN World of Assassination" (a non-Steam shortcut name) opened a
 * moderation review issue because OpenAI flagged it as violence. Game titles
 * are routinely violent, so for user_proton_configs.app_name that category
 * alone no longer counts; every other layer and category still does.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, '.github/scripts/moderate-content.mjs');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

// Jest here has no ESM transform (import() of the .mjs throws), so evaluate
// just the two exported helpers from the real source text.
function loadHelpers() {
  const constSrc = SRC.match(/export const APP_NAME_IGNORED_OPENAI_CATEGORIES = [^;]+;/)[0];
  const fnStart = SRC.indexOf('export function effectiveOpenAICategories');
  const fnSrc = SRC.slice(fnStart, SRC.indexOf('\n}\n', fnStart) + 2);
  const body = `${constSrc}\n${fnSrc}`.replace(/export /g, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { APP_NAME_IGNORED_OPENAI_CATEGORIES, effectiveOpenAICategories };`)();
}

describe('app_name OpenAI category filter (#545)', () => {
  const mod = loadHelpers();

  test('violence alone is ignored for app_name', () => {
    expect(mod.APP_NAME_IGNORED_OPENAI_CATEGORIES).toEqual(['violence']);
    expect(mod.effectiveOpenAICategories(['violence'], mod.APP_NAME_IGNORED_OPENAI_CATEGORIES)).toEqual([]);
  });

  test('other categories still flag, including graphic violence', () => {
    const ignored = mod.APP_NAME_IGNORED_OPENAI_CATEGORIES;
    expect(mod.effectiveOpenAICategories(['violence', 'hate'], ignored)).toEqual(['hate']);
    expect(mod.effectiveOpenAICategories(['violence/graphic'], ignored)).toEqual(['violence/graphic']);
    expect(mod.effectiveOpenAICategories(['sexual', 'harassment'], ignored)).toEqual(['sexual', 'harassment']);
  });

  test('no ignore list keeps everything, and missing categories are safe', () => {
    expect(mod.effectiveOpenAICategories(['violence'])).toEqual(['violence']);
    expect(mod.effectiveOpenAICategories(undefined, ['violence'])).toEqual([]);
  });

  test('only the app_name scan passes the ignore list; user_systems.label does not', () => {
    const proton = SRC.slice(SRC.indexOf("table: 'user_proton_configs'"), SRC.indexOf("table: 'user_systems'"));
    const systems = SRC.slice(SRC.indexOf("table: 'user_systems'"));
    expect(proton).toMatch(/ignoreOpenAICategories: APP_NAME_IGNORED_OPENAI_CATEGORIES/);
    expect(systems.slice(0, 400)).not.toMatch(/ignoreOpenAICategories/);
  });

  test('banned phrases and the wordlist run before OpenAI and ignore nothing', () => {
    const fn = SRC.slice(SRC.indexOf('async function checkTextAgainstAllLayers'));
    expect(fn.indexOf('bannedPhrasesFilter.check')).toBeLessThan(fn.indexOf('moderateWithOpenAI'));
    expect(fn.indexOf('wordlistFilter.check')).toBeLessThan(fn.indexOf('moderateWithOpenAI'));
  });
});
