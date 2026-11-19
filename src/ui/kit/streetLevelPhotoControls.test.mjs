// The Street Level photo viewer (KartaView, Panoramax) is a view with kit
// controls: StreetLevelPhotoViewer draws what the photo viewer presents and
// hand-writes no <button> and no Material Symbols span; its ‹ › are ghost
// UiButtons, not pressed toggles, whose glyphs are text characters. The
// photo viewer builds no element of its own, and the street-level layer it
// belongs to needs no Vue: the application shell publishes its
// presentation to the store the view renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
/** The template block: everything outside script, style and comments. */
const template = (file) =>
  read(file)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
// An opening tag's attributes, quoted values may hold `>` (`() => x`).
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const tags = (markup, name) =>
  markup.match(new RegExp(String.raw`<${name}\b${ATTRS}>`, 'g')) ?? [];
// An attribute's name, outside the quoted values.
const names = (attrs) => attrs.replace(/"[^"]*"|'[^']*'/g, '""');

const VIEW = 'ui/views/panels/StreetLevelPhotoViewer.vue';
const VIEWER = 'layers/streetLevel/photoViewer.js';

test('the photo viewer hand-writes no button; ‹ and › are kit buttons', () => {
  const markup = template(VIEW);
  assert.deepEqual(markup.match(/<button\b/gi) ?? [], [], VIEW);
  assert.deepEqual(markup.match(/<(select|input)\b/gi) ?? [], [], VIEW);
  const buttons = tags(markup, 'UiButton');
  assert.equal(buttons.length, 2);
  assert.equal(tags(markup, 'UiCloseButton').length, 0);
  // Ghost buttons with the classes street-level.css styles.
  for (const [button, side] of [
    [buttons[0], 'prev'],
    [buttons[1], 'next'],
  ]) {
    assert.doesNotMatch(button, /\svariant=/);
    assert.match(
      button,
      new RegExp(`\\sclass="sl-photo-step sl-photo-step-${side}"`),
    );
  }
});

test('the photo viewer hand-writes no Material glyph', () => {
  const markup = template(VIEW);
  assert.deepEqual(markup.match(/material-symbols/g) ?? [], [], VIEW);
  assert.equal(tags(markup, 'UiIcon').length, 0);
  // ‹ and › are text characters.
  assert.match(markup, />‹<\/UiButton\s*>/);
  assert.match(markup, />›<\/UiButton\s*>/);
});

test('the step buttons are not pressed toggles', () => {
  const markup = template(VIEW);
  for (const [tag, attrs] of markup.matchAll(
    new RegExp(String.raw`<[A-Za-z][\w-]*\b(${ATTRS})>`, 'g'),
  )) {
    assert.doesNotMatch(
      names(attrs),
      /(?:^|\s)(?::|v-bind:)?aria-pressed(?=[\s=/]|$)/,
      tag,
    );
    assert.doesNotMatch(
      attrs,
      /(?:^|\s)(?:v-bind|:)=(?:"[^"]*aria-?pressed[^"]*"|'[^']*aria-?pressed[^']*')/i,
      tag,
    );
    assert.doesNotMatch(names(attrs), /(?:^|\s)(?::|v-bind:)?pressed\b/, tag);
  }
});

test('the photo viewer is drawn by its view, and its layer needs no Vue', () => {
  const source = read(VIEWER);
  // No element made, inserted, moved, removed or written: the view does
  // all of that. (An Image the loader downloads with is not on the page.)
  for (const write of [
    /createElement/,
    /\b(?:inner|outer)HTML\b/,
    /insertAdjacent(?:HTML|Element|Text)/,
    /\.(?:append|prepend|appendChild|insertBefore|replaceWith|replaceChildren|before|after)\(/,
    /\.remove\(\)/,
    /\.(?:set|remove|toggle)Attribute(?:NS)?\(/,
    /\.(?:classList|className|dataset|style)\b/,
    /\.(?:hidden|disabled|textContent|innerText|tabIndex|title|alt)\s*=[^=]/,
    /from 'vue'|\.vue'/,
  ])
    assert.doesNotMatch(source, write);
  const markup = template(VIEW);
  const opening = (name, attribute) =>
    new RegExp(String.raw`<${name}\b${ATTRS}\s${attribute}${ATTRS}>`);
  for (const part of [
    opening('div', 'class="sl-photo-viewer"'),
    opening('img', 'class="sl-photo-flat"'),
    opening('canvas', ':key="photo.canvasKey"'),
    opening('canvas', 'class="sl-photo-pano"'),
  ])
    assert.match(markup, part);
  const groups = JSON.parse(
    readFileSync(
      new URL('../../../scripts/package-boundaries.json', import.meta.url),
      'utf8',
    ),
  );
  const layer = groups['street-level-layer'];
  assert.ok(layer.modules.includes(`src/${VIEWER}`));
  assert.equal(layer.external.includes('vue'), false);
  assert.equal(
    layer.modules.some((module) => module.endsWith('.vue')),
    false,
  );
});
