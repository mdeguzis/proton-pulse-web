/**
 * Tests for the notes formatting help expander (#22 follow-up): a small
 * <details> next to editable notes fields documenting the {spoiler}
 * syntax. Lives in js/shared/submit.js and is reused by both the submit
 * form HTML and the profile edit modal.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUBMIT_SRC      = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'submit.js'), 'utf8');
const EDIT_MODALS_SRC = fs.readFileSync(path.join(ROOT, 'js', 'profile', 'components', 'edit-modals.js'), 'utf8');
const SITE_CSS        = fs.readFileSync(path.join(ROOT, 'css', 'shared', 'site.css'), 'utf8');

describe('notesFormattingHelpHtml helper', () => {
  test('is exported from js/shared/submit.js', () => {
    expect(SUBMIT_SRC).toContain('export function notesFormattingHelpHtml()');
  });

  test('renders a native <details>/<summary> so it works with no JS', () => {
    const fn = SUBMIT_SRC.slice(
      SUBMIT_SRC.indexOf('export function notesFormattingHelpHtml'),
      SUBMIT_SRC.indexOf('export function notesFormattingHelpHtml') + 800
    );
    expect(fn).toContain('<details class="formatting-help">');
    expect(fn).toContain('<summary>Formatting help</summary>');
  });

  test('documents the {spoiler} macro with a code-wrapped example', () => {
    const fn = SUBMIT_SRC.slice(
      SUBMIT_SRC.indexOf('export function notesFormattingHelpHtml'),
      SUBMIT_SRC.indexOf('export function notesFormattingHelpHtml') + 800
    );
    expect(fn).toContain('<code>{spoiler}your text{/spoiler}</code>');
    expect(fn).toMatch(/blurred span/);
  });
});

describe('submit form Notes section uses the helper (#22 follow-up)', () => {
  test('Notes section-label embeds notesFormattingHelpHtml()', () => {
    expect(SUBMIT_SRC).toMatch(/Notes \$\{notesFormattingHelpHtml\(\)\}/);
  });
});

describe('profile edit modal Notes label uses the helper', () => {
  test('imports the helper from shared/submit.js', () => {
    expect(EDIT_MODALS_SRC).toContain("import { notesFormattingHelpHtml } from '../../shared/submit.js");
  });

  test('embeds the helper next to the Notes label', () => {
    expect(EDIT_MODALS_SRC).toMatch(/Notes \$\{notesFormattingHelpHtml\(\)\}/);
  });
});

describe('site.css styles for .formatting-help', () => {
  test('defines .formatting-help base block', () => {
    expect(SITE_CSS).toContain('.formatting-help {');
  });

  test('summary is link-styled (cursor pointer + accent color)', () => {
    const block = SITE_CSS.slice(
      SITE_CSS.indexOf('.formatting-help > summary {'),
      SITE_CSS.indexOf('.formatting-help > summary {') + 400
    );
    expect(block).toContain('cursor: pointer');
    expect(block).toContain('color: var(--accent');
  });

  test('hides the default disclosure triangle so the inline-flow summary stays clean', () => {
    expect(SITE_CSS).toContain('list-style: none');
    expect(SITE_CSS).toContain('::-webkit-details-marker');
  });

  test('renders the open-state panel with a code-styled monospace example', () => {
    expect(SITE_CSS).toContain('.formatting-help code');
    expect(SITE_CSS).toContain('font-family: var(--mono');
  });
});
