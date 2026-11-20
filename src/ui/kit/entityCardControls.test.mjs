// The entity card's buttons and Material glyphs are the kit's: neither its
// template nor the camera preview and nearby lists it renders hand-writes a
// <button> or a Material Symbols span. The Ask GEV button's chat bubble is
// not a Material symbol the page loads, so it stays drawn as inline SVG; the
// hero views (model, route globe, cockpit view, ground view, graphs) draw
// their own pictures and have no controls.
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
const card = template('EntityCard.vue');
const camera = template('CctvPreview.vue');
const nearby = template('SpotConditions.vue');
const heroViews = [
  'AircraftModelHero.vue',
  'RouteGlobe.vue',
  'FlightCockpitView.vue',
  'SatelliteGroundView.vue',
  'PreviewHud.vue',
  'AltitudeGraph.vue',
].map(template);

test('the entity card hand-writes no button; each is a UiButton', () => {
  for (const markup of [card, camera, nearby, ...heroViews])
    assert.deepEqual(markup.match(/<button\b/gi) ?? [], []);
  // Photos, Route, 3D, Cockpit view, Find it, the cockpit entry, Fly to,
  // Follow and Ask GEV.
  assert.equal(card.match(/<UiButton\b/g)?.length, 9);
  assert.equal(card.match(/<UiCloseButton\b/g)?.length, 1);
  // A camera's bigger view and More info; its popup closes with a UiCloseButton.
  assert.equal(camera.match(/<UiButton\b/g)?.length, 2);
  assert.equal(camera.match(/<UiCloseButton\b/g)?.length, 1);
  // The traffic, hazard, alert and other nearby rows.
  assert.equal(nearby.match(/<UiButton\b/g)?.length, 4);
});

test('the preview switch and Follow are pressed toggles with their classes', () => {
  const previews = card.match(/<UiButton v-if="\w+" :pressed[^>]*>/g) ?? [];
  assert.equal(previews.length, 4);
  for (const button of previews) {
    assert.match(button, /pressed-class="active"/);
    assert.doesNotMatch(button, /aria-pressed|:class=/);
  }
  assert.match(
    card,
    /<UiButton v-if="store\.canFollow\(\)" class="entity-card__action" :pressed="Boolean\(store\.isFollowing\(\)\)" pressed-class="entity-card__action--on"/,
  );
});

test('the entity card hand-writes no Material glyph; each is a UiIcon', () => {
  for (const markup of [card, camera, nearby, ...heroViews])
    assert.deepEqual(markup.match(/material-symbols-outlined/g) ?? [], []);
  const counts = [
    // The preview switch's three, the hero glyph, the header icon, Find
    // it, the warning, the route's plane, the route note and the three
    // actions.
    [card, 12],
    // Bigger view, the popup's camera and More info.
    [camera, 3],
    // The two weather glyphs, five headings and three row glyphs.
    [nearby, 10],
  ];
  for (const [markup, count] of counts) {
    const icons = markup.match(/<UiIcon\b[^>]*>/g) ?? [];
    assert.equal(icons.length, count);
    // Without it the kit writes an 18px size that beats the card's own rules.
    for (const icon of icons) assert.match(icon, /:size="null"/);
  }
});

test('the only inline SVG glyph is the Ask GEV chat bubble', () => {
  const svgs = [...card.matchAll(/<svg\b[\s\S]*?<\/svg\s*>/g)].map((m) => m[0]);
  assert.equal(svgs.length, 1);
  assert.match(svgs[0], /<path d="M4 5h16v11H9l-5 4z" \/>/);
  for (const markup of [camera, nearby])
    assert.deepEqual(markup.match(/<svg\b/gi) ?? [], []);
});
