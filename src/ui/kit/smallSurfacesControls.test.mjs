// The small surfaces' buttons and Material glyphs are the kit's: the locale
// picker, the phone tab bar, the globe actions and compass, the imagery
// divider, the scene sharing dialog, the layer group index, the celestial
// ring, the title logo, Exit clean view, the Intel HUD, the News
// cards, the rail cards, the layer rows' toggles, the credits line and the
// camera calibration chips hand-write no <button> and no Material Symbols
// span. The Omnibar guide's extra rings are its template's, not built in
// script. The locale picker's globe, caret and check and a News card's
// category icon stay inline SVG: none is a Material symbol the page loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
/** The template block: everything outside script, style and comments. */
const template = (file) =>
  read(file)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
// An opening tag's attributes, quoted values may hold `>` (`() => x`).
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const tags = (markup, name) =>
  markup.match(new RegExp(String.raw`<${name}\b${ATTRS}>`, 'g')) ?? [];

// Per file: its UiButtons, UiCloseButtons and UiIcons.
const SURFACES = {
  'views/panels/LocalePicker.vue': [1, 0, 0],
  'views/panels/PhoneTabBar.vue': [1, 0, 1],
  'views/panels/GlobeCompass.vue': [1, 0, 1],
  // Clear, share, tilt and reset; the clear, tilt and reset glyphs.
  'views/panels/GlobeActions.vue': [4, 0, 3],
  'views/panels/ImagerySplitView.vue': [1, 0, 0],
  // The body's buttons and the footer's.
  'views/panels/SceneDialog.vue': [2, 0, 0],
  'views/panels/LayerSectionIndex.vue': [1, 0, 0],
  // The sun and moon markers.
  'views/panels/CelestialRing.vue': [0, 0, 2],
  'views/panels/OmnibarGuide.vue': [3, 1, 0],
  // The overlay targets' buttons and the title logo.
  'views/SceneChromeView.vue': [2, 0, 0],
  'views/DisplayControlsView.vue': [1, 0, 0],
  // No controls: the HUD has no cockpit entry on purpose; Enter Cockpit is
  // only on an entity's card.
  'views/IntelHudView.vue': [0, 0, 0],
  // The card's face and the selected card's clear chip.
  'news/NewsCard.vue': [2, 0, 0],
  'rail/RailCard.vue': [1, 0, 0],
  'layerPanel/LayerRows.vue': [1, 0, 0],
  'credits/CreditsView.vue': [1, 1, 0],
  'cctv/CctvCalValue.vue': [1, 0, 0],
};

test('the small surfaces hand-write no button; each is a kit button', () => {
  for (const [file, [buttons, closes]] of Object.entries(SURFACES)) {
    const markup = template(file);
    assert.deepEqual(markup.match(/<button\b/gi) ?? [], [], file);
    assert.equal(tags(markup, 'UiButton').length, buttons, file);
    assert.equal(tags(markup, 'UiCloseButton').length, closes, file);
  }
});

test('the small surfaces hand-write no Material glyph; each is a UiIcon', () => {
  for (const [file, [, , count]] of Object.entries(SURFACES)) {
    const markup = template(file);
    assert.deepEqual(
      markup.match(/material-symbols-outlined/g) ?? [],
      [],
      file,
    );
    const icons = tags(markup, 'UiIcon');
    assert.equal(icons.length, count, file);
    // Without it the kit writes an 18px size that beats the sites' own rules.
    for (const icon of icons) assert.match(icon, /\s:size="null"/, file);
  }
});

test('the only inline SVG glyphs are the locale picker’s and a News category’s', () => {
  for (const file of Object.keys(SURFACES)) {
    const expected =
      file === 'views/panels/LocalePicker.vue'
        ? 3
        : file === 'news/NewsCard.vue'
          ? 1
          : 0;
    assert.equal(template(file).match(/<svg\b/g)?.length ?? 0, expected, file);
  }
});

test('buttons whose owner patches synchronously redraw their contents with it', () => {
  // A UiButton's slot renders inside the button, a tick after a change the
  // button's own attributes do not carry; a conditional slot is redrawn with
  // its view.
  // How many of each file's first buttons the owner redraws and reads.
  for (const [file, count] of [
    ['news/NewsCard.vue', 1],
    ['rail/RailCard.vue', 1],
    ['credits/CreditsView.vue', 1],
    ['views/panels/OmnibarGuide.vue', 3],
  ]) {
    const markup = template(file);
    const buttons = tags(markup, 'UiButton').slice(0, count);
    assert.equal(buttons.length, count, file);
    let from = 0;
    for (const button of buttons) {
      from = markup.indexOf(button, from) + button.length;
      assert.match(
        markup.slice(from),
        /^\s*<template v-if="redrawWithView" #default\s*>/,
        file,
      );
    }
    assert.match(read(file), /const redrawWithView = true;/, file);
  }
});

test('the Omnibar guide draws its extra rings in its template', () => {
  const guide = template('views/panels/OmnibarGuide.vue');
  assert.match(
    guide,
    /<div\s+v-for="i in view\.subRings"\s+:key="i"\s+class="gev-guide-ring gev-guide-ring--sub"\s*><\/div\s*>\s*<\/div\s*>\s*<\/Teleport/,
  );
  const owner = read('omnibarGuide.js');
  assert.deepEqual(owner.match(/createElement\(/g), ['createElement(']);
  assert.doesNotMatch(owner, /\.className\s*=|\.append\(/);
  assert.match(owner, /view\.subRings = rest\.length;\s*paint\(\);/);
});

test('the layer disclosure builds no control', () => {
  // Its one `<button` is a comment's word for the element Chromium focuses.
  const disclosure = read('panelDisclosure.js');
  assert.doesNotMatch(disclosure, /createElement|innerHTML|insertAdjacentHTML/);
  const code = disclosure
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /<button/);
});
