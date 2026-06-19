const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('configurable card size (S/M/L)', () => {
  const homeSrc = read('js/app/components/home.js');
  const cssSrc = read('css/app/app.css');

  test('renders an S/M/L size toggle', () => {
    expect(homeSrc).toContain('id="home-size-toggle"');
    expect(homeSrc).toContain('data-size="sm"');
    expect(homeSrc).toContain('data-size="md"');
    expect(homeSrc).toContain('data-size="lg"');
  });

  test('size is a saved user preference defaulting to medium', () => {
    expect(homeSrc).toContain("const SIZE_KEY = 'pp:grid-size'");
    expect(homeSrc).toContain('localStorage.setItem(SIZE_KEY, size)');
    expect(homeSrc).toContain("return SIZES.includes(s) ? s : 'md'");
    expect(homeSrc).toContain('applyGridSize(_savedSize())');
  });

  test('size class is applied to both card lists', () => {
    expect(homeSrc).toContain("['cards-recent', 'cards-popular'].forEach");
    expect(homeSrc).toContain('el2.classList.add(`cards--${size}`)');
  });

  test('CSS defines the three card sizes', () => {
    expect(cssSrc).toContain('.cards--sm .game-card-thumb');
    expect(cssSrc).toContain('.cards--md .game-card-thumb');
    expect(cssSrc).toContain('.cards--lg .game-card-thumb');
  });
});
