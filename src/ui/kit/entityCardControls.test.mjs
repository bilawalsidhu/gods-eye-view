// The entity card and its detail views use kit buttons and Material glyphs.
// Ask GEV uses an inline SVG for its chat bubble. The hero views draw the
// model, route, cockpit, ground view and graphs without their own controls.
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
// The card's hero image and its preview switch live in their own view.
const preview = template('EntityPreview.vue');
// A place's details, its coordinates line and its nearby lists.
const places = ['PlaceDetails.vue', 'PlaceLine.vue', 'NearbyLists.vue'].map(
  template,
);
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
  for (const markup of [card, preview, camera, nearby, ...places, ...heroViews])
    assert.deepEqual(markup.match(/<button\b/gi) ?? [], []);
  // Find it, the cockpit entry, Follow, Fly to, Pin, Dock, Ask GEV and
  // the pinned layer action.
  assert.equal(card.match(/<UiButton\b/g)?.length, 8);
  assert.equal(card.match(/<UiCloseButton\b/g)?.length, 1);
  // Show here (while docked), Photos, Route, 3D, Cockpit view, Map,
  // Play/Pause, a satellite's Play/Pause, a place's Street View photo, TR-3B
  // and Dock.
  assert.equal(preview.match(/<UiButton\b/g)?.length, 11);
  // A camera's bigger view; its popup closes with a UiCloseButton. There is
  // no More info: a camera's details are on its card.
  assert.equal(camera.match(/<UiButton\b/g)?.length, 1);
  assert.equal(camera.match(/<UiCloseButton\b/g)?.length, 1);
  // SpotConditions owns the hazard and alert rows and the scope switch.
  assert.equal(nearby.match(/<UiButton\b/g)?.length, 3);
  assert.equal(places[2].match(/<UiButton\b/g)?.length, 1);
});

test('the preview switch and Follow are pressed toggles with their classes', () => {
  // Photos, Route, 3D, Cockpit view and Map; the map view and the Play/Pause
  // toggle sit at the end of the switch.
  const previews =
    preview.match(
      /<UiButton v-if="views\.includes\('\w+'\)" :pressed[^>]*>/g,
    ) ?? [];
  assert.equal(previews.length, 5);
  for (const button of previews) {
    assert.match(button, /pressed-class="active"/);
    assert.doesNotMatch(button, /aria-pressed|:class=/);
  }
  assert.match(
    preview,
    /<UiButton class="entity-card__preview-play" :disabled="reducedMotion" :label=/,
  );
  assert.match(
    card,
    /<UiButton v-if="store\.canFollow\(\)" class="entity-card__action" :class="\{ 'entity-card__action--primary': [^"]*\}" :pressed="Boolean\(store\.isFollowing\(\)\)" pressed-class="entity-card__action--on"/,
  );
});

test('the entity card hand-writes no Material glyph; each is a UiIcon', () => {
  for (const markup of [card, preview, camera, nearby, ...places, ...heroViews])
    assert.deepEqual(markup.match(/material-symbols-outlined/g) ?? [], []);
  const counts = [
    // The hero glyph, Find it, the warning, the cockpit entry, Follow, Fly
    // to, Pin, Dock, the pinned layer action, the route's plane and the route note.
    [card, 11],
    // Show here, the preview switch's four glyphs, Play/Pause, a
    // satellite's Play/Pause and Dock.
    [preview, 8],
    // Bigger view and the popup's camera.
    [camera, 2],
    // The Conditions here, hazard and alert headings and their rows; there
    // are no weather glyphs, and the other headings and rows are in the
    // shared nearby lists.
    [nearby, 6],
    // A list's heading and an item's motion.
    [places[2], 2],
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
  for (const markup of [preview, camera, nearby, ...places])
    assert.deepEqual(markup.match(/<svg\b/gi) ?? [], []);
});
