// The Bhote Koshi event's controls are the kit's: its reconstruction panel
// hand-writes no <button> and no Material Symbols span, its buttons are ghost
// UiButtons that keep their data-action hooks for bhote-koshi.css and the
// tests, and its cinematic button is a pressed toggle whose state the event
// layer presents as `pressed`, not as an `aria-pressed` it writes. The
// embedded media cards are an SFC rather than markup built in script; they
// hold no control (the original link stays a link), and the script builds
// only what the provider SDKs need: their script and preconnect tags, the
// overlay root, and the Facebook player node it warms and carries into a
// card.
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

const PANEL = 'ui/views/panels/BhoteKoshiPanel.vue';
const CARDS = 'ui/bhoteKoshi/BhoteKoshiMediaCards.vue';
// Per file: its UiButtons, UiCloseButtons, UiSliders and UiIcons.
const SURFACES = {
  // Previous and next beat, Play, Play scene, Cinematic, Full story, Open
  // original, Lower gorge, a field report (one tag, one per report) and Open
  // public map; Close; the split and progress sliders.
  [PANEL]: [10, 1, 2, 0],
  // The media cards: a frame, a leader, a footer and the original link.
  [CARDS]: [0, 0, 0, 0],
};

test('the Bhote Koshi views hand-write no button; each is a kit button', () => {
  for (const [file, [buttons, closes, sliders]] of Object.entries(SURFACES)) {
    const markup = template(file);
    assert.deepEqual(markup.match(/<button\b/gi) ?? [], [], file);
    assert.deepEqual(markup.match(/<(select|input)\b/gi) ?? [], [], file);
    assert.equal(tags(markup, 'UiButton').length, buttons, file);
    assert.equal(tags(markup, 'UiCloseButton').length, closes, file);
    assert.equal(tags(markup, 'UiSlider').length, sliders, file);
  }
});

test('the Bhote Koshi views hand-write no Material glyph', () => {
  for (const [file, [, , , icons]] of Object.entries(SURFACES)) {
    const markup = template(file);
    assert.deepEqual(markup.match(/material-symbols/g) ?? [], [], file);
    const found = tags(markup, 'UiIcon');
    assert.equal(found.length, icons, file);
    for (const icon of found) assert.match(icon, /\s:size="null"/, file);
  }
});

test('the cinematic button takes the kit pressed state', () => {
  for (const file of Object.keys(SURFACES))
    for (const [tag, attrs] of template(file).matchAll(
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
    }
  const pressed = tags(template(PANEL), 'UiButton').filter((tag) =>
    /\s:pressed=/.test(tag),
  );
  assert.equal(pressed.length, 1);
  assert.match(
    pressed[0],
    /^<UiButton data-action="cinematic" :pressed="Boolean\(panel\.refs\.cinematicButton\.pressed\)"/,
  );
  // bhote-koshi.css styles the pressed button by its aria-pressed.
  assert.doesNotMatch(pressed[0], /pressed-class/);
  // The layer presents the state; it writes no aria-pressed of its own.
  const layer = read('data/bhoteKoshiEvent.js');
  assert.doesNotMatch(layer, /aria-pressed/);
  assert.match(
    layer,
    /setElementProperty\(button, 'pressed', _cinematicActive\)/,
  );
});

test('the media cards are drawn by their view, not built in script', () => {
  const source = read('data/bhoteKoshiEmbeddedMedia.js');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|createElementNS/);
  // Provider scripts and preconnects, the overlay root, and the Facebook
  // embed node and its warm host. The YouTube API's script is youtubeApi.js's.
  assert.deepEqual(
    [...source.matchAll(/createElement\('(\w+)'\)/g)].map((m) => m[1]),
    ['script', 'script', 'link', 'div', 'div', 'div'],
  );
  assert.match(source, /renderVue\(\s*h\(BhoteKoshiMediaCards,/);
  const cards = template(CARDS);
  const opening = (name, attribute) =>
    new RegExp(String.raw`<${name}\b${ATTRS}\s${attribute}${ATTRS}>`);
  for (const part of [
    opening('iframe', 'class="bhote-embedded-media-warmup"'),
    opening('section', 'class="bhote-embedded-callout"'),
    opening('svg', 'class="bhote-embedded-callout-leader"'),
    opening('div', 'class="bhote-embedded-callout-body" data-overlay-input'),
    opening('small', 'role="status"'),
    opening('a', 'target="_blank" rel="noopener noreferrer"'),
  ])
    assert.match(cards, part);
});
