// The command dock's and the Context panel's buttons and Material glyphs are
// the kit's: neither the dock, the Context view nor the view context it
// shows while nothing is picked hand-writes a <button> or a Material Symbols
// span. The dock's style buttons are pressed toggles with `active`, its
// glyphs (◯ ▦ 🌙 🌡️ ✦ ◐, the search 🔎 and the collapse +) are text
// characters, not Material symbols, and stay plain text. Context's tabs and
// its Contacts mode button are `role="tab"` controls: they say they are
// chosen with `aria-selected` and keep their own `active` class, never
// `aria-pressed`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** A view's template block: everything outside script, style and comments. */
function template(file) {
  const source = readFileSync(
    new URL(`../views/${file}`, import.meta.url),
    'utf8',
  );
  return source
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}
// A tag's attributes, read past quoted values so a handler's `=>` does not
// end the tag early.
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const tag = (pattern, flags = '') =>
  new RegExp(pattern.replaceAll('ATTRS', ATTRS), flags);
const tags = (markup, name) =>
  markup.match(tag(String.raw`<${name}\bATTRS>`, 'g')) ?? [];

const dock = template('CommandDockView.vue');
const context = template('ContextView.vue');
const inView = template('panels/ViewContext.vue');
const views = {
  // The six style buttons, the two tray toggles and their pins, the map
  // source chips, Location's collapse, its landmark and city pills and the
  // search toggle.
  'CommandDockView.vue': { markup: dock, buttons: 15, icons: 0, closes: 0 },
  // Search and Expand in the header, the two tabs, Contacts, the cockpit
  // entry, SEARCH NEARBY SITES and the TR-3B chip.
  'ContextView.vue': { markup: context, buttons: 8, icons: 7, closes: 0 },
  // An off layer's worldwide tile, an item's row, the place and layer chips
  // and Ask GEV; a layer's Turn off is a UiCloseButton. The glyphs: the
  // header's eye, a worldwide tile's (on and off), a layer group's, an
  // item's motion and the layer chips' add.
  'panels/ViewContext.vue': { markup: inView, buttons: 5, icons: 6, closes: 1 },
};

test('the dock and Context hand-write no button; each is a UiButton', () => {
  for (const [file, { markup, buttons, closes }] of Object.entries(views)) {
    assert.deepEqual(markup.match(/<button\b/gi) ?? [], [], file);
    assert.deepEqual(markup.match(/<component\b/gi) ?? [], [], file);
    assert.equal(tags(markup, 'UiButton').length, buttons, file);
    assert.equal(tags(markup, 'UiCloseButton').length, closes, file);
  }
});

test('the style buttons are pressed toggles with active', () => {
  assert.doesNotMatch(dock, /v-class-toggle="\{[^"]*\bactive\b/);
  const styles = tags(dock, 'UiButton').filter((b) =>
    /class="style-btn"/.test(b),
  );
  assert.deepEqual(
    styles.map((b) => b.match(/data-style="(\w+)"/)[1]),
    ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir'],
  );
  for (const button of styles) {
    const name = button.match(/data-style="(\w+)"/)[1];
    assert.match(button, /\spressed-class="active"/, name);
    // Normal stays the pressed one until a style is published.
    assert.match(
      button,
      name === 'normal'
        ? /\s:pressed="!style \|\| style\.name === 'normal'"/
        : new RegExp(String.raw`\s:pressed="style\?\.name === '${name}'"`),
      name,
    );
  }
});

test('no tag hand-writes aria-pressed; the pressed toggles take :pressed', () => {
  for (const [file, { markup }] of Object.entries(views))
    assert.doesNotMatch(
      markup,
      tag(String.raw`<\w+\bATTRS\s:?aria-pressed`),
      file,
    );
  const pressed = (markup) =>
    tags(markup, 'UiButton').filter((b) => /\s:pressed=/.test(b)).length;
  // The six styles, two pins, map sources, landmarks and cities.
  assert.equal(pressed(dock), 11);
  // Search, Expand and TR-3B.
  assert.equal(pressed(context), 3);
  assert.equal(pressed(inView), 0);
});

test("Context's tabs say they are chosen, not pressed", () => {
  const tabs = tags(context, 'UiButton').filter((b) => /\srole="tab"/.test(b));
  assert.equal(tabs.length, 3);
  for (const button of tabs) {
    assert.match(button, /\s:aria-selected=/);
    assert.doesNotMatch(button, /\s:pressed=/);
    assert.match(button, /\s(?::class|v-class-toggle)="\{ active: /);
  }
});

test('they hand-write no Material glyph; each is a UiIcon', () => {
  for (const [file, { markup, icons }] of Object.entries(views)) {
    assert.deepEqual(
      markup.match(/material-symbols-outlined/g) ?? [],
      [],
      file,
    );
    const found = tags(markup, 'UiIcon');
    assert.equal(found.length, icons, file);
    // Without it the kit writes an 18px size that beats the site rules.
    for (const icon of found) assert.match(icon, /\s:size="null"/, file);
  }
  // An item's motion glyph is an image with its own name, not decoration.
  const [motion] = tags(inView, 'UiIcon').filter((i) =>
    /view-context__row-motion/.test(i),
  );
  assert.match(motion, /\srole="img"/);
  assert.match(motion, /\s:aria-label=/);
  assert.match(motion, /\s:aria-hidden="null"/);
});
