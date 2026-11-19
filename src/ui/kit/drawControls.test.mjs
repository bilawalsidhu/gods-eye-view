// UTILITIES ▸ Draw (its toggle, Clear, the colour swatches and the drawn
// shapes' rows), Import and the Street Level panel are on the kit: none of
// them hand-writes a <button>, a Material Symbols span, a select, a checkbox
// or a range. The Draw toggle is a pressed toggle with `active`. The colour
// swatches are `role="radio"` buttons: they say they are chosen with
// `aria-checked` and their own `active` class, never `aria-pressed`. A drawn
// shape's show/hide renames itself (Show …, Hide …) rather than being pressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (file) =>
  readFileSync(new URL(`../views/panels/${file}`, import.meta.url), 'utf8');
/** A view's template block: everything outside script, style and comments. */
const template = (file) =>
  source(file)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
// A tag's attributes, read past quoted values so a handler's `=>` does not
// end the tag early.
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const tag = (pattern, flags = '') =>
  new RegExp(pattern.replaceAll('ATTRS', ATTRS), flags);
const tags = (markup, name) =>
  markup.match(tag(String.raw`<${name}\bATTRS>`, 'g')) ?? [];

const views = {
  // Draw and Clear.
  'DrawControls.vue': { buttons: 2, icons: 1, closes: 0 },
  // The five colours, one v-for.
  'DrawSwatches.vue': { buttons: 1, icons: 0, closes: 0 },
  // A row's swatch, show/hide, the application's actions and fly to; remove
  // is a UiCloseButton.
  'DrawMarkList.vue': { buttons: 4, icons: 3, closes: 1 },
  // Import and a file's row actions.
  'GeoImport.vue': { buttons: 2, icons: 2, closes: 0 },
  // The status toggle, EXPAND and the nearest-imagery button; the viewer's
  // close. EXPAND's ⤢ ⤡ and the errors' ⚠ are text, not Material symbols.
  'StreetLevelPanel.vue': { buttons: 3, icons: 0, closes: 1 },
};
const markup = Object.fromEntries(
  Object.keys(views).map((file) => [file, template(file)]),
);

test('the Draw, Import and Street Level views hand-write no button', () => {
  for (const [file, { buttons, closes }] of Object.entries(views)) {
    const html = markup[file];
    assert.deepEqual(html.match(/<button\b/gi) ?? [], [], file);
    assert.deepEqual(html.match(/<component\b/gi) ?? [], [], file);
    assert.equal(tags(html, 'UiButton').length, buttons, file);
    assert.equal(tags(html, 'UiCloseButton').length, closes, file);
  }
});

test('they hand-write no select, checkbox or range', () => {
  for (const [file, html] of Object.entries(markup)) {
    assert.deepEqual(html.match(/<select\b/gi) ?? [], [], file);
    assert.doesNotMatch(
      html,
      tag(String.raw`<input\bATTRS\stype="(?:checkbox|range)"`),
      file,
    );
  }
  // SINCE is the kit's range.
  assert.equal(tags(markup['StreetLevelPanel.vue'], 'UiSlider').length, 1);
});

test('they hand-write no Material glyph; each is a UiIcon sized by the site', () => {
  for (const [file, { icons }] of Object.entries(views)) {
    const html = markup[file];
    assert.deepEqual(html.match(/material-symbols-outlined/g) ?? [], [], file);
    const found = tags(html, 'UiIcon');
    assert.equal(found.length, icons, file);
    // Without it the kit writes an 18px size that beats the site rules.
    for (const icon of found) assert.match(icon, /\s:size="null"/, file);
  }
  // Draw's and Import's glyphs keep pp-icon, which sizes them.
  for (const file of ['DrawControls.vue', 'GeoImport.vue']) {
    const [icon] = tags(markup[file], 'UiIcon');
    assert.match(icon, /\sclass="pp-icon"/, file);
  }
});

test('no tag hand-writes aria-pressed; Draw is a pressed toggle with active', () => {
  for (const [file, html] of Object.entries(markup))
    assert.doesNotMatch(
      html,
      tag(String.raw`<\w+\bATTRS\s:?aria-pressed`),
      file,
    );
  const [draw] = tags(markup['DrawControls.vue'], 'UiButton').filter((b) =>
    /\sid="draw-toggle"/.test(b),
  );
  assert.match(draw, /\s:pressed="draw\?\.active \?\? false"/);
  assert.match(draw, /\spressed-class="active"/);
  const [clear] = tags(markup['DrawControls.vue'], 'UiButton').filter((b) =>
    /\sid="draw-clear"/.test(b),
  );
  assert.doesNotMatch(clear, /\s:pressed=/);
  // A shape's show/hide says what it does in its name, not by being pressed.
  for (const button of tags(markup['DrawMarkList.vue'], 'UiButton'))
    assert.doesNotMatch(button, /\s:pressed=/);
});

test('the colour swatches are radios chosen by aria-checked, never pressed', () => {
  const [swatch] = tags(markup['DrawSwatches.vue'], 'UiButton');
  assert.match(swatch, /\srole="radio"/);
  assert.match(
    swatch,
    /\s:aria-checked="String\(color === props\.modelValue\)"/,
  );
  assert.match(swatch, /\s:class="\{ active: color === props\.modelValue \}"/);
  assert.doesNotMatch(swatch, /\s:pressed=|\spressed-class=/);
});

test('code that focuses a converted button reaches its element', () => {
  // A template ref on a component holds the component, not the button.
  assert.match(
    source('DrawSwatches.vue'),
    /:ref="\(swatch\) => \(buttons\[index\] = swatch\?\.\$el\)"/,
  );
  assert.match(
    source('GeoImport.vue'),
    /importButton\.value\?\.\$el\.focus\(\)/,
  );
});
