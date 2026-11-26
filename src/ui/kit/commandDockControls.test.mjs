// The command dock's and the Context panel's buttons and Material glyphs are
// the kit's: neither the dock, the Context view nor the view context it
// shows while nothing is picked hand-writes a <button> or a Material Symbols
// span (the dock's own buttons are the voice control's). Context's tabs and
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
const suggested = template('panels/SuggestedLayers.vue');
const nearby = template('panels/NearbyLists.vue');
const views = {
  // The voice control, the tab bar and the reticles are views of their own.
  'CommandDockView.vue': { markup: dock, buttons: 0, icons: 0, closes: 0 },
  // Search and Expand in the header, the two tabs, Contacts, the cockpit
  // entry, SEARCH NEARBY SITES and the TR-3B chip.
  'ContextView.vue': { markup: context, buttons: 8, icons: 7, closes: 0 },
  // Buttons select a globe row or open Data Layers. Icons mark the pointer,
  // weather, worldwide counts, layer counts and readings. Globe rows use EntityMark.
  'panels/ViewContext.vue': { markup: inView, buttons: 2, icons: 5, closes: 0 },
  // Open in Data Layers; a layer's glyph and the pointer's layers.
  'panels/SuggestedLayers.vue': {
    markup: suggested,
    buttons: 1,
    icons: 2,
    closes: 0,
  },
  // An item's row; a list's glyph and an item's motion.
  'panels/NearbyLists.vue': { markup: nearby, buttons: 1, icons: 2, closes: 0 },
};

test('the dock and Context hand-write no button; each is a UiButton', () => {
  for (const [file, { markup, buttons, closes }] of Object.entries(views)) {
    assert.deepEqual(markup.match(/<button\b/gi) ?? [], [], file);
    assert.deepEqual(markup.match(/<component\b/gi) ?? [], [], file);
    assert.equal(tags(markup, 'UiButton').length, buttons, file);
    assert.equal(tags(markup, 'UiCloseButton').length, closes, file);
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
  assert.equal(pressed(dock), 0);
  // Search, Expand and TR-3B.
  assert.equal(pressed(context), 3);
  assert.equal(pressed(inView), 0);
  assert.equal(pressed(suggested), 0);
  assert.equal(pressed(nearby), 0);
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
  // Each globe-view block's head and each nearby row lead with a mark.
  assert.equal(tags(inView, 'EntityMark').length, 1);
  assert.equal(tags(nearby, 'EntityMark').length, 1);
  const [motion] = tags(nearby, 'UiIcon').filter((i) =>
    /nearby-lists__motion/.test(i),
  );
  assert.match(motion, /\srole="img"/);
  assert.match(motion, /\s:aria-label=/);
  assert.match(motion, /\s:aria-hidden="null"/);
});
