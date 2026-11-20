// The Cockpit HUD's controls and glyphs are the kit's: no Cockpit view
// hand-writes a <button>, a Material Symbols span, a select, a checkbox or a
// range. Its buttons are ghost UiButtons that keep their ids, classes and
// labels for the Cockpit controller's listeners and the cockpit stylesheets;
// its glyphs are UiIcons with `:size="null"`, so those stylesheets still size
// them. The utility strip's −, ◀ ▶ and transport glyphs and the orbital
// zoom's − and + are text characters, not Material symbols, and stay text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

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
const views = {
  // The vision selector's Previous, Current and Next, Look ahead, and the
  // view switcher's Reset and Exit; the speed and altitude rims' pointers,
  // the two vision chevrons, the reticle, the heading caret and the view
  // switcher's two glyphs.
  'CockpitView.vue': { buttons: 6, icons: 8 },
  // Display's and Radio's collapse and launcher buttons, Radio's Enable,
  // Previous, Play and Next, and the desktop rail's two items and glyphs.
  'panels/CockpitUtilityControls.vue': { buttons: 10, icons: 2 },
  // Previous, Next, Auto, the card's collapse and the four page tabs (LIVE
  // shows only with a stream); the first, second and fourth draw a glyph.
  'panels/CockpitBriefing.vue': { buttons: 8, icons: 3 },
  // Previous, Next, the card's collapse and Weather; three of them draw a
  // glyph, and the nearest contact's arrow is the fourth.
  'panels/CockpitContext.vue': { buttons: 4, icons: 4 },
  // A signal row's target and its chevron.
  'panels/CockpitSignalList.vue': { buttons: 1, icons: 1 },
  // TLE, Nadir, Zoom out, Zoom in and Sensor, and a station's Previous and
  // Next view, which draw the two glyphs.
  'panels/CockpitOrbital.vue': { buttons: 7, icons: 2 },
  // The LIVE page's Previous, Next, Play and Try again; the first three draw
  // a glyph.
  'panels/CockpitLivePage.vue': { buttons: 4, icons: 3 },
  // The range step.
  'panels/CockpitRadar.vue': { buttons: 1, icons: 0 },
  // The flight plan's arrow.
  'panels/CockpitRoute.vue': { buttons: 0, icons: 1 },
  // Readouts only.
  'panels/CockpitProgress.vue': { buttons: 0, icons: 0 },
  'panels/CockpitRollingValue.vue': { buttons: 0, icons: 0 },
};
// A tag's attributes, read past quoted values so a handler's `=>` does not
// end the tag early.
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const tag = (pattern, flags = '') =>
  new RegExp(pattern.replaceAll('ATTRS', ATTRS), flags);
const markup = Object.fromEntries(
  Object.keys(views).map((file) => [file, template(file)]),
);

test('every Cockpit view is in the list above', () => {
  const dir = (sub) =>
    readdirSync(new URL(`../views/${sub}`, import.meta.url))
      .filter((name) => /^Cockpit.*\.vue$/.test(name))
      .map((name) => sub + name);
  assert.deepEqual(
    [...dir(''), ...dir('panels/')].sort(),
    Object.keys(views).sort(),
  );
});

test('the Cockpit views hand-write no button; each is a UiButton', () => {
  for (const [file, { buttons }] of Object.entries(views)) {
    assert.deepEqual(markup[file].match(/<button\b/gi) ?? [], [], file);
    assert.equal(
      markup[file].match(/<UiButton\b/g)?.length ?? 0,
      buttons,
      file,
    );
  }
});

test('the Cockpit views hand-write no select, checkbox or range', () => {
  for (const [file, view] of Object.entries(markup)) {
    assert.deepEqual(view.match(/<(select|input)\b/gi) ?? [], [], file);
  }
  // The compact Radio volume.
  assert.equal(
    markup['panels/CockpitUtilityControls.vue'].match(/<UiSlider\b/g)?.length,
    1,
  );
});

test('the pressed toggles take the kit pressed state', () => {
  for (const view of Object.values(markup))
    assert.doesNotMatch(view, tag(String.raw`<\w+\bATTRS\s:?aria-pressed`));
  const pressed = Object.values(markup).flatMap(
    (view) =>
      view.match(tag(String.raw`<UiButton\bATTRS\s:pressed=ATTRS>`, 'g')) ?? [],
  );
  // Radio's Enable, the briefing's Auto and the Contact card's Weather.
  assert.equal(pressed.length, 3);
  for (const button of pressed) assert.match(button, /:pressed="Boolean\(/);
  assert.match(
    markup['panels/CockpitUtilityControls.vue'],
    tag(
      String.raw`<UiButton\s+id="cockpit-radio-enable-btn"ATTRS\s:pressed="Boolean\(cockpit\?\.enable\.active\)" pressed-class="active"`,
    ),
  );
  assert.match(
    markup['panels/CockpitBriefing.vue'],
    tag(
      String.raw`<UiButton\s+id="cockpit-brief-auto"ATTRS\s:pressed="Boolean\(b\.autoRotate\)"`,
    ),
  );
  assert.match(
    markup['panels/CockpitContext.vue'],
    tag(
      String.raw`<UiButton\s+id="cockpit-weather-toggle"ATTRS\s:pressed="Boolean\(c\.weather\)"`,
    ),
  );
});

test('the Cockpit views hand-write no Material glyph; each is a UiIcon', () => {
  for (const [file, { icons }] of Object.entries(views)) {
    assert.deepEqual(
      markup[file].match(/material-symbols-outlined/g) ?? [],
      [],
      file,
    );
    const found =
      markup[file].match(tag(String.raw`<UiIcon\bATTRS>`, 'g')) ?? [];
    assert.equal(found.length, icons, file);
    // Without it the kit writes an 18px size that beats the cockpit's rules.
    for (const icon of found) assert.match(icon, /\s:size="null"/, file);
  }
});

test('the heading caret outranks the kit icon rule that loads after it', () => {
  const css = readFileSync(
    new URL('../styles/cockpit.css', import.meta.url),
    'utf8',
  );
  // kit.css's `.ui-icon` sets display and line-height with one class and
  // loads after cockpit.css, so a one-class caret rule would lose to it.
  assert.match(
    css,
    /\n\.cockpit-compass \.cockpit-heading-caret \{\n {2}display: block;/,
  );
  assert.doesNotMatch(css, /\n\.cockpit-heading-caret \{/);
});
