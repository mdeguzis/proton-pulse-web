/**
 * Source-shape tests for the ?md=1 markdown-editor spike on submit.html
 * (#153 follow-up). Behavioral coverage would need jsdom + the markdown-it
 * CDN bundle; pin the wiring instead so a regression on the flag path or
 * on the raw-notes-payload contract fails loudly.
 */

const fs = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const SUBMIT_MAIN = fs.readFileSync(path.join(ROOT, 'js', 'submit', 'main.js'), 'utf8');
const SUBMIT_HTML = fs.readFileSync(path.join(ROOT, 'submit.html'), 'utf8');
const GAME_CSS    = fs.readFileSync(path.join(ROOT, 'css', 'app', 'game-header.css'), 'utf8');

describe('markdown editor spike (#153)', () => {
  test('submit.html loads markdown-it via CDN', () => {
    // Pin the specific version so a future upgrade is a conscious edit
    // rather than a silent bump.
    expect(SUBMIT_HTML).toContain('markdown-it@14.1.0/dist/markdown-it.min.js');
  });

  test('enhancer wires whenever window.markdownit is present (no flag gate)', () => {
    // Flag was removed once the spike graduated site-wide -- the CDN
    // load is the only gate now.
    expect(SUBMIT_MAIN).not.toContain("params.get('md') === '1'");
    expect(SUBMIT_MAIN).toContain("typeof window.markdownit === 'function'");
    expect(SUBMIT_MAIN).toContain('enhanceNotesWithMarkdown(el)');
  });

  test('enhancer runs after populateSubmitForm so the textarea exists', () => {
    const popIdx = SUBMIT_MAIN.indexOf('await populateSubmitForm(el)');
    const wireIdx = SUBMIT_MAIN.indexOf('enhanceNotesWithMarkdown(el)');
    expect(popIdx).toBeGreaterThan(0);
    expect(wireIdx).toBeGreaterThan(popIdx);
  });

  test('enhanceNotesWithMarkdown targets the Notes textarea by name', () => {
    expect(SUBMIT_MAIN).toContain(`rootEl.querySelector('textarea[name="notes"]')`);
  });

  test('enhancer keeps the textarea in the DOM (raw markdown is the submit payload)', () => {
    // The textarea must not be replaced; submitReport reads form.notes.value
    // so the raw markdown flows into user_configs.notes unchanged.
    const fn = SUBMIT_MAIN.slice(
      SUBMIT_MAIN.indexOf('function enhanceNotesWithMarkdown'),
    );
    expect(fn).toContain('wrapper.appendChild(textarea)');
    expect(fn).not.toContain('textarea.remove()');
    expect(fn).not.toContain('textarea.replaceWith');
  });

  test('markdown-it configured with html:false so raw HTML never renders', () => {
    // The Notes payload is untrusted user input rendered inline on report
    // cards; disabling raw HTML in the parser removes the primary XSS
    // surface. linkify + breaks match GitHub-style behaviour.
    expect(SUBMIT_MAIN).toContain('html: false');
    expect(SUBMIT_MAIN).toContain('linkify: true');
    expect(SUBMIT_MAIN).toContain('breaks: true');
  });

  test('enhancer is idempotent via data-mdEnhanced marker', () => {
    expect(SUBMIT_MAIN).toContain("textarea.dataset.mdEnhanced === '1'");
    expect(SUBMIT_MAIN).toContain("textarea.dataset.mdEnhanced = '1'");
  });

  test('Write and Preview tabs are wired with aria-selected', () => {
    const fn = SUBMIT_MAIN.slice(
      SUBMIT_MAIN.indexOf('function enhanceNotesWithMarkdown'),
    );
    expect(fn).toContain('data-md-tab="write"');
    expect(fn).toContain('data-md-tab="preview"');
    expect(fn).toContain(`aria-selected="true"`);
    expect(fn).toContain('setAttribute(\'aria-selected\'');
  });

  test('empty notes preview shows a placeholder instead of a blank div', () => {
    expect(SUBMIT_MAIN).toContain('md-editor-empty');
    expect(SUBMIT_MAIN).toMatch(/Nothing to preview yet/);
  });
});

describe('markdown editor CSS shape', () => {
  test('base .md-editor and tab classes exist', () => {
    expect(GAME_CSS).toContain('.md-editor {');
    expect(GAME_CSS).toContain('.md-editor-tabs {');
    expect(GAME_CSS).toContain('.md-editor-tab {');
    expect(GAME_CSS).toContain('.md-editor-tab--active {');
    expect(GAME_CSS).toContain('.md-editor-preview {');
  });

  test('preview surface renders headings / code / blockquote with expected styling anchors', () => {
    expect(GAME_CSS).toMatch(/\.md-editor-preview h1[\s\S]{0,200}line-height/);
    expect(GAME_CSS).toContain('.md-editor-preview code');
    expect(GAME_CSS).toContain('.md-editor-preview blockquote');
  });
});
