const fs = require('fs');
const path = require('path');

const optionsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'options', 'main.js'),
  'utf8'
);
const optionsHtml = fs.readFileSync(
  path.join(__dirname, '..', 'options.html'),
  'utf8'
);

describe('options page -- reports per page (load count) preference', () => {
  test('options.html has a 50/100/150/200 radio group', () => {
    expect(optionsHtml).toContain('id="opt-load-count"');
    ['50', '100', '150', '200'].forEach(v => {
      expect(optionsHtml).toContain(`name="load-count" value="${v}"`);
    });
    // 50 is the default selection
    expect(optionsHtml).toMatch(/name="load-count" value="50" checked/);
  });

  test('main.js persists the choice under pp:load-count', () => {
    expect(optionsSrc).toContain("const LOAD_COUNT_KEY = 'pp:load-count'");
    expect(optionsSrc).toContain("const LOAD_COUNTS = ['50', '100', '150', '200']");
    expect(optionsSrc).toContain('localStorage.setItem(LOAD_COUNT_KEY, r.value)');
  });
});
