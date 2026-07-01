/**
 * Regression pin for the yes/no question card styling on the submit form.
 *
 * The row of ~8 fault questions used to render as a tight vertical stack
 * with no visual separation, so it was easy to lose track of which prompt
 * you were answering. Each .sf-question is now its own bordered card with
 * padding + margin so the answer surface for each question is distinct.
 */

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'app', 'game-header.css'),
  'utf8',
);

function ruleBody(selector) {
  const idx = CSS.indexOf(selector);
  if (idx < 0) return '';
  const open = CSS.indexOf('{', idx);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('.sf-question card shape gives each yes/no question its own surface', () => {
  test('has padding, border, and background so questions look like cards', () => {
    const body = ruleBody('.sf-question {');
    expect(body).toMatch(/padding:\s*10px\s+12px/);
    expect(body).toMatch(/background:\s*var\(--s1\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(body).toMatch(/border-radius:\s*6px/);
  });

  test('has vertical margin so adjacent cards do not touch', () => {
    const body = ruleBody('.sf-question {');
    expect(body).toMatch(/margin:\s*0\s+0\s+14px/);
  });

  test('.sf-q-label is a touch larger + heavier so the prompt reads first', () => {
    // Newline prefix skips the .sf-needs-answer variant which shares the class name.
    const body = ruleBody('\n.sf-q-label {');
    expect(body).toMatch(/font-size:\s*0\.85rem/);
    expect(body).toMatch(/font-weight:\s*500/);
    // Extra gap below the label pushes the Yes/No buttons off the prompt line.
    expect(body).toMatch(/margin-bottom:\s*8px/);
  });
});
