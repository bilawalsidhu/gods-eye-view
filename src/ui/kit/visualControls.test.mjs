// The Visual panel's buttons and Material glyphs are the kit's: neither its
// template nor the presets it renders hand-writes a <button>, a Material
// Symbols span or an inline SVG. The toggles' text glyphs (◎ ▣ ✈ □ ✨ 🔍)
// and the presets' style glyphs are characters, not Material symbols, so
// they stay text the panel's rules size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** A view's template block: everything outside script and style. */
function template(file) {
  const source = readFileSync(
    new URL(`../views/panels/${file}`, import.meta.url),
    'utf8',
  );
  return source.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '');
}
const panel = template('DisplayPanel.vue');
const presets = template('VisualPresets.vue');

test('the Visual panel hand-writes no button; each is a UiButton', () => {
  for (const markup of [panel, presets])
    assert.deepEqual(markup.match(/<button\b/gi) ?? [], []);
  // HUD, Sonar, Detection, 3D, Clean UI, Celestial, Bloom, Sharpen and
  // Reset to default.
  assert.equal(panel.match(/<UiButton\b/g)?.length, 9);
  // The style presets and the map source chips.
  assert.equal(presets.match(/<UiButton\b/g)?.length, 2);
  // Scope, the sky rows and the application's toggle rows.
  assert.equal(panel.match(/<UiCheckbox\b/g)?.length, 3);
  // 3D model coverage and detection label allocation.
  assert.equal(panel.match(/<UiSegmented\b/g)?.length, 2);
});

test('the Visual panel hand-writes no Material glyph; each is a UiIcon', () => {
  for (const markup of [panel, presets]) {
    assert.deepEqual(markup.match(/material-symbols-outlined/g) ?? [], []);
    assert.deepEqual(markup.match(/<svg\b/gi) ?? [], []);
  }
  const icons = panel.match(/<UiIcon\b[^>]*>/g) ?? [];
  // Scope, Celestial, the sky rows, the application's rows and Reset.
  assert.equal(icons.length, 5);
  // Without it the kit writes an 18px size that beats the panel's own rules.
  for (const icon of icons) assert.match(icon, /:size="null"/);
});

test('the toggles keep their text glyphs as plain spans', () => {
  const glyphs = [...panel.matchAll(/<span class="pp-icon">([^<]*)<\/span>/g)];
  assert.deepEqual(
    glyphs.map((m) => m[1]),
    ['&#x25CE;', '&#x25A3;', '&#x2708;', '&#x25A1;', '&#x2728;', '&#x1F50D;'],
  );
});
