// The space missions, Radio and provider settings controls are the kit's:
// none of their views hand-writes a <button>, a Material Symbols span, a
// select or a checkbox. The RTL-SDR card's Connect and its FM and ADS-B
// modes are pressed toggles with `active`; the pins of the mission card,
// the radio mini player and Now playing are pressed toggles with their own
// pressed class, as are the station tag chips and the speaker's mute.
// Radio's Play and the card's Locate keep their own `active` class, since
// their words change with their state rather than saying they are pressed.
// The RTL-SDR card's FM frequency stays a native number field (the kit has
// none), and the radio tuner's range stays native: its owner moves the
// handle back to the selected station on a drag's first input without
// changing the slot.
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
const byId = (markup, name, id) => {
  const found = tags(markup, name).filter((t) =>
    new RegExp(String.raw`\sid="${id}"`).test(t),
  );
  assert.equal(found.length, 1, id);
  return found[0];
};

// Each view's UiButtons, UiCloseButtons, UiIcons, UiSelects and UiSliders.
const VIEWS = {
  // Replay, the replay's pause, Fly to and Pin; the replay's Cancel close;
  // the rocket and the three actions' glyphs. Back is the list card's.
  'panels/MissionDetail.vue': [4, 1, 4, 0, 1],
  // Its rows and pager are the kit's list card.
  'panels/NearbyMissions.vue': [0, 0, 0, 0, 0],
  'panels/MissionReplayOverlay.vue': [0, 0, 0, 0, 0],
  'panels/AwarenessDirection.vue': [0, 0, 0, 0, 0],
  // Connect, Locate, Change device, FM, ADS-B, Tune and the two seeks.
  'panels/SdrCard.vue': [8, 0, 0, 1, 1],
  // PREV, PLAY, NEXT and STOP, and the volume.
  'panels/RadioFold.vue': [4, 0, 0, 0, 1],
  'panels/RadioTuner.vue': [0, 0, 0, 0, 0],
  // Pin, Previous, Play or Pause, Next and Close; the station's glyph and
  // the four buttons' glyphs.
  'panels/RadioMiniPlayer.vue': [4, 1, 5, 0, 0],
  // Play or Pause, Fly to, Pin and a tag chip. The shared list card
  // owns the station buttons. Five glyphs are local.
  'panels/RadioStations.vue': [4, 0, 5, 0, 0],
  // The speaker and the popover's Mute, each with its glyph; the slider.
  'panels/RadioVolume.vue': [2, 0, 2, 0, 1],
  // The POWER UP chip and its bolt, a key's REMOVE, the voice auth toggle
  // and SAVE KEYS; the dialog's close.
  'ProviderSettingsView.vue': [4, 1, 1, 0, 0],
};
const views = Object.entries(VIEWS).map(([file, counts]) => ({
  file,
  markup: template(file),
  counts,
}));

test('they hand-write no button; each is a UiButton or UiCloseButton', () => {
  for (const { file, markup, counts } of views) {
    assert.deepEqual(markup.match(/<button\b/gi) ?? [], [], file);
    assert.deepEqual(markup.match(/<component\b/gi) ?? [], [], file);
    assert.equal(tags(markup, 'UiButton').length, counts[0], file);
    assert.equal(tags(markup, 'UiCloseButton').length, counts[1], file);
  }
});

test('they hand-write no Material glyph; each is a UiIcon sized by its site', () => {
  for (const { file, markup, counts } of views) {
    assert.deepEqual(
      markup.match(/material-symbols-outlined/g) ?? [],
      [],
      file,
    );
    const icons = tags(markup, 'UiIcon');
    assert.equal(icons.length, counts[2], file);
    // Without it the kit writes an 18px size that beats the site rules.
    for (const icon of icons) assert.match(icon, /\s:size="null"/, file);
  }
});

test('their selects and ranges are the kit’s, apart from the tuner', () => {
  for (const { file, markup, counts } of views) {
    assert.deepEqual(markup.match(/<select\b/gi) ?? [], [], file);
    assert.doesNotMatch(markup, /type="checkbox"/, file);
    assert.equal(tags(markup, 'UiSelect').length, counts[3], file);
    assert.equal(tags(markup, 'UiSlider').length, counts[4], file);
    const ranges = tags(markup, 'input').filter((i) =>
      /\stype="range"/.test(i),
    );
    assert.equal(ranges.length, file === 'panels/RadioTuner.vue' ? 1 : 0, file);
  }
});

test('no tag hand-writes aria-pressed; the pressed toggles take :pressed', () => {
  const pressed = {
    'panels/MissionDetail.vue': 1,
    'panels/SdrCard.vue': 3,
    'panels/RadioMiniPlayer.vue': 1,
    'panels/RadioStations.vue': 2,
    'panels/RadioVolume.vue': 2,
  };
  for (const { file, markup } of views) {
    assert.doesNotMatch(
      markup,
      tag(String.raw`<\w+\bATTRS\s(?:v-bind)?:?aria-pressed`),
      file,
    );
    const toggles = tags(markup, 'UiButton').filter((b) =>
      /\s:pressed=/.test(b),
    );
    assert.equal(toggles.length, pressed[file] ?? 0, file);
  }
  const sdr = views.find((v) => v.file === 'panels/SdrCard.vue').markup;
  for (const id of ['sdr-connect-btn', 'sdr-mode-fm-btn', 'sdr-mode-adsb-btn'])
    assert.match(byId(sdr, 'UiButton', id), /\spressed-class="active"/, id);
  // The pins keep the class their stylesheets key on.
  for (const [file, pin, on] of [
    ['panels/MissionDetail.vue', 'data-mission-pin', 'entity-card__action--on'],
    ['panels/RadioMiniPlayer.vue', 'class="radio-mini__pin"', 'is-on'],
    [
      'panels/RadioStations.vue',
      'class="entity-card__action entity-card__action--pin"',
      'entity-card__action--on',
    ],
  ]) {
    const markup = views.find((v) => v.file === file).markup;
    const found = tags(markup, 'UiButton').filter((b) => b.includes(pin));
    assert.equal(found.length, 1, file);
    assert.match(found[0], /\s:pressed="isPinned"/, file);
    assert.ok(found[0].includes(` pressed-class="${on}"`), file);
  }
});

test('Play and Locate keep their own active class rather than pressed', () => {
  const sdr = views.find((v) => v.file === 'panels/SdrCard.vue').markup;
  const radio = views.find((v) => v.file === 'panels/RadioFold.vue').markup;
  for (const [markup, id] of [
    [radio, 'radio-play-btn'],
    [sdr, 'sdr-locate-btn'],
  ]) {
    const button = byId(markup, 'UiButton', id);
    assert.doesNotMatch(button, /\s:pressed=/, id);
    assert.match(button, /\sv-class-toggle="\{ active: /, id);
  }
});
