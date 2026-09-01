import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GLIDER_CLASSES,
  GLIDER_CLASS_ORDER,
  OGN_TYPE_CLASS,
  gliderClassColor,
  gliderClassLegend,
  gliderClassOf,
} from './gliderClass.js';
import { OGN_AIRCRAFT_TYPES } from './ognFallback.js';

test('every class in the legend order exists in the registry, and vice versa', () => {
  assert.deepEqual(
    [...GLIDER_CLASS_ORDER].sort(),
    Object.keys(GLIDER_CLASSES).sort(),
  );
});

test('the layer is scoped to exactly gliders and balloons', () => {
  assert.deepEqual(Object.keys(GLIDER_CLASSES).sort(), ['balloon', 'glider']);
  assert.deepEqual(OGN_TYPE_CLASS, { glider: 'glider', balloon: 'balloon' });
});

test('every surfaced OGN type maps to a real class', () => {
  for (const [typeLabel, klass] of Object.entries(OGN_TYPE_CLASS)) {
    assert.ok(GLIDER_CLASSES[klass], `${typeLabel} → unknown class ${klass}`);
  }
});

test('every type this layer surfaces is a label the normalizer can actually produce', () => {
  const produced = new Set(Object.values(OGN_AIRCRAFT_TYPES));
  for (const typeLabel of Object.keys(OGN_TYPE_CLASS)) {
    assert.ok(produced.has(typeLabel), `${typeLabel} is never emitted by normalizeOgnMarker`);
  }
});

test('gliders and balloons resolve to their own classes', () => {
  assert.equal(gliderClassOf('glider'), 'glider');
  assert.equal(gliderClassOf('balloon'), 'balloon');
});

test('ADS-B relay traffic is not surfaced — the over-count bug', () => {
  // OGN ground stations relay the Mode-S/ADS-B targets they also receive under
  // the generic 'plane' (ftype 8) and 'jet' (9) codes. Those already carry a
  // transponder and are already drawn by flights.js; counting them here is what
  // flooded the layer with "gliders" that were ordinary airliners.
  assert.equal(gliderClassOf('plane'), null);
  assert.equal(gliderClassOf('jet'), null);
});

test('everything but gliders and balloons is out of scope', () => {
  for (const typeLabel of [
    'paraglider', 'hang-glider', 'tow-plane', 'helicopter', 'drone',
    'ufo', 'airship', 'parachute', 'drop-plane',
  ]) {
    assert.equal(gliderClassOf(typeLabel), null, `${typeLabel} should not be surfaced`);
  }
});

test("'unknown' (OGN ftype 0/14/15) is excluded — ftype 14 is a static ground beacon, not traffic", () => {
  assert.equal(gliderClassOf('unknown'), null);
});

test('no two classes share a color — the legend must be a 1:1 key to the map', () => {
  const colors = GLIDER_CLASS_ORDER.map((klass) => GLIDER_CLASSES[klass].color);
  assert.equal(new Set(colors).size, colors.length);
});

test('gliderClassOf tolerates missing or unknown labels without throwing', () => {
  for (const value of [undefined, null, '', 'not-a-type']) {
    assert.equal(gliderClassOf(value), null);
  }
  // A caller that paints before it filters still gets a usable color.
  assert.equal(gliderClassColor(undefined), GLIDER_CLASSES.glider.color);
});

test('the legend lists present classes in order, and omits empty ones', () => {
  const legend = gliderClassLegend({ balloon: 3, glider: 7 });
  assert.deepEqual(legend.map((item) => item.label), ['GLIDER', 'BALLOON']);
  assert.deepEqual(legend.map((item) => item.count), [7, 3]);
  assert.equal(legend[0].color, GLIDER_CLASSES.glider.color);
  assert.ok(legend[0].blurb);
});

test('an empty or absent tally yields an empty legend, never a throw', () => {
  assert.deepEqual(gliderClassLegend({}), []);
  assert.deepEqual(gliderClassLegend(null), []);
  assert.deepEqual(gliderClassLegend(undefined), []);
  assert.deepEqual(gliderClassLegend({ glider: 0 }), []);
});
