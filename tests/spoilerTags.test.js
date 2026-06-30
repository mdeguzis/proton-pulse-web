/**
 * Tests for #22: escWithSpoilers parses {spoiler}...{/spoiler} into a
 * tap-to-reveal blurred span, leaving everything outside the markers
 * normally HTML-escaped.
 */

const { loadEsm } = require('./_esm-vm.js');

function loadUtils() {
  return loadEsm(['js/app/utils.js'], {
    document: {
      createElement: () => {
        let txt = '';
        return {
          set textContent(v) { txt = String(v || ''); },
          get textContent() { return txt; },
          get innerHTML() {
            // Minimal HTML entity escape for the test stub.
            return txt
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
          },
        };
      },
    },
    console,
  });
}

describe('escWithSpoilers (#22)', () => {
  test('returns empty string for empty input', () => {
    const { escWithSpoilers } = loadUtils();
    expect(escWithSpoilers('')).toBe('');
    expect(escWithSpoilers(null)).toBe('');
    expect(escWithSpoilers(undefined)).toBe('');
  });

  test('passes plain text through with HTML escaping but no markup', () => {
    const { escWithSpoilers } = loadUtils();
    expect(escWithSpoilers('hello world')).toBe('hello world');
    expect(escWithSpoilers('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('wraps {spoiler}...{/spoiler} in a span with role + tabindex', () => {
    const { escWithSpoilers } = loadUtils();
    const out = escWithSpoilers('{spoiler}ending: A wins{/spoiler}');
    expect(out).toContain('<span class="spoiler" role="button" tabindex="0"');
    expect(out).toContain('aria-label="Spoiler -- tap to reveal"');
    expect(out).toContain('ending: A wins</span>');
  });

  test('escapes inner spoiler content to prevent XSS', () => {
    const { escWithSpoilers } = loadUtils();
    const out = escWithSpoilers('{spoiler}<img src=x onerror=alert(1)>{/spoiler}');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  test('handles multiple spoilers in one string', () => {
    const { escWithSpoilers } = loadUtils();
    const out = escWithSpoilers('before {spoiler}a{/spoiler} middle {spoiler}b{/spoiler} after');
    const spans = out.match(/class="spoiler"/g) || [];
    expect(spans.length).toBe(2);
    expect(out).toContain('>a</span>');
    expect(out).toContain('>b</span>');
    expect(out.startsWith('before ')).toBe(true);
    expect(out.endsWith(' after')).toBe(true);
  });

  test('mixed plain + spoiler segments stay in order', () => {
    const { escWithSpoilers } = loadUtils();
    const out = escWithSpoilers('Plain {spoiler}HIDDEN{/spoiler} Plain');
    const before = out.indexOf('Plain');
    const span   = out.indexOf('class="spoiler"');
    const after  = out.lastIndexOf('Plain');
    expect(before).toBeLessThan(span);
    expect(span).toBeLessThan(after);
  });

  test('unclosed spoiler tag is left as escaped plain text (no run-on blur)', () => {
    const { escWithSpoilers } = loadUtils();
    const out = escWithSpoilers('hello {spoiler}forgot to close');
    expect(out).not.toContain('class="spoiler"');
    expect(out).toContain('{spoiler}forgot to close');
  });

  test('is case-insensitive for tag names', () => {
    const { escWithSpoilers } = loadUtils();
    expect(escWithSpoilers('{SPOILER}x{/SPOILER}')).toContain('class="spoiler"');
    expect(escWithSpoilers('{Spoiler}y{/spoiler}')).toContain('class="spoiler"');
  });

  test('multi-line spoiler content is preserved', () => {
    const { escWithSpoilers } = loadUtils();
    const out = escWithSpoilers('{spoiler}line one\nline two{/spoiler}');
    expect(out).toContain('line one\nline two');
  });

  test('onclick + onkeydown handlers are inline (no separate delegate needed)', () => {
    const { escWithSpoilers } = loadUtils();
    const out = escWithSpoilers('{spoiler}x{/spoiler}');
    expect(out).toContain("this.classList.toggle('revealed')");
    expect(out).toContain("event.key==='Enter'");
    expect(out).toContain("event.key===' '");
  });

  test('content lives in a nested .spoiler-content span so CSS can swap a "Reveal" placeholder in', () => {
    const { escWithSpoilers } = loadUtils();
    const out = escWithSpoilers('{spoiler}hidden{/spoiler}');
    expect(out).toContain('<span class="spoiler-content">hidden</span>');
  });
});

describe('spoiler CSS shows a "Reveal spoiler text" placeholder', () => {
  const fs = require('fs');
  const path = require('path');
  const REPORTS_CSS = fs.readFileSync(
    path.join(__dirname, '..', 'css', 'app', 'reports.css'),
    'utf8'
  );

  test('.spoiler::before injects the Reveal spoiler text label', () => {
    expect(REPORTS_CSS).toMatch(/\.spoiler::before \{ content: "Reveal spoiler text"/);
  });

  test('.spoiler hides the .spoiler-content child until .revealed', () => {
    expect(REPORTS_CSS).toContain('.spoiler > .spoiler-content { display: none; }');
    expect(REPORTS_CSS).toContain('.spoiler.revealed > .spoiler-content { display: inline; }');
    expect(REPORTS_CSS).toContain('.spoiler.revealed::before { display: none; }');
  });
});
