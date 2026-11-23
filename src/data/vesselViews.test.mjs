import assert from 'node:assert/strict';
import test from 'node:test';
import { registerVesselViews, vesselViewRef } from './vesselViews.js';
import { VESSEL_VIEWS, viewLayout } from './viewSheet.js';
import { vesselSprite } from './vesselSprites.js';
import {
  VESSEL_KINDS,
  VESSEL_SHAPES,
  vesselKind,
  vesselShape,
} from './vesselTypes.js';

test('VESSEL_VIEWS holds a block for every hull shape, each on the sheet', () => {
  const layout = viewLayout(VESSEL_VIEWS.sheet);
  assert.equal(layout.frames, VESSEL_VIEWS.frames);
  // To the horizon and no further: a ship is never seen from below.
  assert.equal(
    (VESSEL_VIEWS.sheet.rings.length - 1) * VESSEL_VIEWS.sheet.ringStepDeg,
    90,
  );
  // Every shape, in order, a block each: the ten kinds, then the rest.
  assert.deepEqual(Object.keys(VESSEL_VIEWS.subjects), [...VESSEL_SHAPES]);
  assert.deepEqual(
    VESSEL_SHAPES.slice(0, VESSEL_KINDS.length).toSorted(),
    [...VESSEL_KINDS].sort(),
  );
  VESSEL_SHAPES.forEach((shape, i) =>
    assert.equal(VESSEL_VIEWS.subjects[shape], i * VESSEL_VIEWS.frames, shape),
  );
  assert.ok(
    VESSEL_SHAPES.length * VESSEL_VIEWS.frames <=
      VESSEL_VIEWS.sheet.columns * VESSEL_VIEWS.sheet.rows,
  );
});

test('every AIS ship type, 0 to 99, draws a shape the sheet holds, in its kind’s colour', () => {
  // ITU-R M.1371: the families by their tens, and the types with a hull of
  // their own.
  const shapeOf = (code) => vesselShape(String(code));
  const kindOf = (code) => vesselKind(String(code));
  for (let code = 0; code < 100; code++) {
    assert.ok(Number.isInteger(VESSEL_VIEWS.subjects[shapeOf(code)]), code);
    assert.ok(VESSEL_KINDS.includes(kindOf(code)), code);
  }
  const drawn = (codes, shape, kind = shape) =>
    codes.forEach((code) =>
      assert.deepEqual([shapeOf(code), kindOf(code)], [shape, kind], code),
    );
  const tens = (ten) => Array.from({ length: 10 }, (_, i) => ten * 10 + i);
  drawn(tens(7), 'cargo');
  drawn(tens(8), 'tanker');
  drawn(tens(6), 'passenger');
  drawn(tens(4), 'highspeed');
  drawn([30], 'fishing');
  drawn([31, 32, 52], 'tug');
  drawn([36], 'sailing');
  drawn([37], 'pleasure');
  drawn([35, 55], 'military');
  drawn([33], 'dredger', 'other');
  // Pilot, port tender and anti-pollution craft are service boats (the
  // tug's colour); search and rescue is a patrol colour. One small hull.
  drawn([50, 53, 54], 'pilot', 'tug');
  drawn([51], 'pilot', 'military');
  // Wing-in-ground craft, diving and medical vessels, the reserved and
  // spare codes and "other": the plain hull.
  drawn(
    [0, 1, 19, ...tens(2), 34, 38, 39, 56, 57, 58, 59, ...tens(9)],
    'other',
  );
  // A feed that names the type in words draws the same shapes.
  assert.equal(vesselShape('Dredger'), 'dredger');
  assert.equal(vesselShape('Pilot Vessel'), 'pilot');
  assert.equal(vesselShape('Search and Rescue'), 'pilot');
  // However the words are joined, the hull and the colour are the code's.
  for (const text of ['Search & Rescue', 'Search-and-rescue', 'SAR'])
    assert.deepEqual(
      [vesselShape(text), vesselKind(text)],
      ['pilot', 'military'],
      text,
    );
  for (const text of ['Anti Pollution', 'Anti-pollution', 'Port Tender'])
    assert.deepEqual(
      [vesselShape(text), vesselKind(text)],
      ['pilot', 'tug'],
      text,
    );
  assert.equal(vesselShape('Tug'), 'tug');
  assert.equal(vesselShape('Container Ship'), 'cargo');
  assert.equal(vesselShape(''), 'other');
});

test('a vessel draws its shape’s block of the sheet, with its kind’s flat hull to fall back on', () => {
  for (const kind of VESSEL_KINDS) {
    const ref = vesselViewRef(kind);
    assert.deepEqual(ref, {
      views: VESSEL_VIEWS.id,
      first: VESSEL_VIEWS.subjects[kind],
      fallback: vesselSprite(kind),
    });
    assert.ok(Object.isFrozen(ref));
    // One object a shape and kind: an unchanged icon is seen as unchanged.
    assert.equal(vesselViewRef(kind), ref);
  }
  // A shape within a kind: its own block, its kind's flat hull.
  assert.deepEqual(vesselViewRef('pilot', 'tug'), {
    views: VESSEL_VIEWS.id,
    first: VESSEL_VIEWS.subjects.pilot,
    fallback: vesselSprite('tug'),
  });
  assert.notEqual(
    vesselViewRef('pilot', 'tug'),
    vesselViewRef('pilot', 'military'),
  );
  assert.equal(
    vesselViewRef('dredger', 'other').first,
    VESSEL_VIEWS.subjects.dredger,
  );
  // A shape the sheet does not hold: its kind's block, then `other`'s.
  assert.equal(
    vesselViewRef('hovercraft', 'highspeed'),
    vesselViewRef('highspeed'),
  );
  assert.equal(vesselViewRef('submarine'), vesselViewRef('other'));
  assert.equal(vesselViewRef(undefined), vesselViewRef('other'));
});

test('the sheet is registered once a port, at the layer’s asset URL, on a renderer that draws views', () => {
  const calls = [];
  const port = { views: (id, sheet) => calls.push([id, sheet]) };
  const views = new Set(['viewSheets']);
  const resolve = (url) => `/gev${url}`;
  assert.equal(registerVesselViews(port, views, resolve), true);
  assert.equal(registerVesselViews(port, views, resolve), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], VESSEL_VIEWS.id);
  assert.deepEqual(calls[0][1], {
    ...VESSEL_VIEWS.sheet,
    image: '/gev/sprites/vessel-views.webp',
  });
  // No capability, no port, or a port without `views`: flat hulls.
  assert.equal(registerVesselViews(port, new Set(), resolve), false);
  assert.equal(registerVesselViews(port, null), false);
  assert.equal(registerVesselViews(null, views), false);
  assert.equal(registerVesselViews({}, views), false);
});
