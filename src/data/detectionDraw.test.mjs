// Unit tests for the pure drawing/format helpers behind the detection overlay.
// These are renderer-agnostic (no Cesium, no DOM) so they pin the Phase-1 label
// + batching behavior and carry straight into the Phase-2 GPU renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFlightLevel,
  formatKnots,
  monoTextWidth,
  composeLabel,
  acquireAlpha,
  appendCornerBracket,
  resolveTier,
  measureLabelCard,
  measureTrackLabel,
  nearFarScale,
  rectIntersectsAny,
  projectionRequestMatches,
  VIEW_PROJECTION_KEYS,
} from './detectionDraw.js';

test('formatFlightLevel converts metres to a 3-digit flight level', () => {
  assert.equal(formatFlightLevel(10363), 'FL340'); // 34,000 ft
  assert.equal(formatFlightLevel(1524), 'FL050');  // 5,000 ft, zero-padded
});

test('formatFlightLevel returns empty string for missing/zero/negative altitude', () => {
  assert.equal(formatFlightLevel(0), '');
  assert.equal(formatFlightLevel(-50), '');
  assert.equal(formatFlightLevel(null), '');
  assert.equal(formatFlightLevel(undefined), '');
  assert.equal(formatFlightLevel(NaN), '');
});

test('formatKnots rounds and suffixes; omits non-positive/non-finite', () => {
  assert.equal(formatKnots(14), '14 kn');
  assert.equal(formatKnots(14.6), '15 kn');
  assert.equal(formatKnots(0), '');
  assert.equal(formatKnots(null), '');
  assert.equal(formatKnots(NaN), '');
});

test('monoTextWidth multiplies length by advance, 0 for empty', () => {
  assert.equal(monoTextWidth('ABCD', 6), 24);
  assert.equal(monoTextWidth('', 6), 0);
  assert.equal(monoTextWidth(null, 6), 0);
});

test('composeLabel: id only -> empty secondary (degrades to today)', () => {
  assert.deepEqual(composeLabel({ id: 'VEH-0001' }), { primary: 'VEH-0001', secondary: '' });
});

test('composeLabel: id + metric -> secondary is the metric', () => {
  assert.deepEqual(composeLabel({ id: 'UAL2476', metric: 'FL340' }), {
    primary: 'UAL2476',
    secondary: 'FL340',
  });
});

test('composeLabel: id + class + metric -> class · metric secondary', () => {
  assert.deepEqual(composeLabel({ id: 'VIPER11', klass: 'MIL', metric: 'FL280' }), {
    primary: 'VIPER11',
    secondary: 'MIL · FL280',
  });
});

test('composeLabel truncates an over-long primary and is defensive about empties', () => {
  assert.equal(composeLabel({ id: 'SUPERLONGVESSELNAME12345' }).primary, 'SUPERLONGVESSELNAM'); // 18
  assert.deepEqual(composeLabel({}), { primary: '', secondary: '' });
});

test('acquireAlpha ramps 0->1 across the fade window', () => {
  assert.equal(acquireAlpha(1000, 1000, 200), 0);
  assert.equal(acquireAlpha(1000, 1100, 200), 0.5);
  assert.equal(acquireAlpha(1000, 1300, 200), 1);
});

test('acquireAlpha clamps and defaults safely', () => {
  assert.equal(acquireAlpha(1000, 900, 200), 0);   // before first-seen
  assert.equal(acquireAlpha(1000, 5000, 200), 1);  // long after
  assert.equal(acquireAlpha(NaN, 5000, 200), 1);   // no timestamp -> visible
  assert.equal(acquireAlpha(1000, 1100, 0), 1);    // no fade -> visible
});

test('appendCornerBracket emits 4 L-shaped corners (4 moveTo + 8 lineTo)', () => {
  const calls = [];
  const sink = {
    moveTo: (x, y) => calls.push(['m', x, y]),
    lineTo: (x, y) => calls.push(['l', x, y]),
  };
  appendCornerBracket(sink, 100, 100, 20, 10);

  assert.equal(calls.length, 12);
  assert.equal(calls.filter((c) => c[0] === 'm').length, 4);
  assert.equal(calls.filter((c) => c[0] === 'l').length, 8);
  // top-left corner of box (x0=80, y0=90), seg = max(4, floor(10*0.55)) = 5
  assert.deepEqual(calls.slice(0, 3), [
    ['m', 80, 95],
    ['l', 80, 90],
    ['l', 85, 90],
  ]);
});

test('resolveTier maps type to a threat tier, with explicit override winning', () => {
  assert.equal(resolveTier({ type: 'AIR' }), 'civil');
  assert.equal(resolveTier({ type: 'AIR', tier: 'military' }), 'military'); // layer-supplied override
  assert.equal(resolveTier({ type: 'SEA' }), 'sea');
  assert.equal(resolveTier({ type: 'SAT' }), 'space');
  assert.equal(resolveTier({ type: 'VEH' }), 'vehicle');
  assert.equal(resolveTier({}), 'civil');
  assert.equal(resolveTier(null), 'civil');
  // Live-traffic congestion tiers ride the same override: keyless VEH
  // contacts carry no tier and keep the stock 'vehicle' color.
  assert.equal(resolveTier({ type: 'VEH', tier: 'veh_jam' }), 'veh_jam');
  assert.equal(resolveTier({ type: 'VEH', tier: 'veh_nodata' }), 'veh_nodata');
});

test('measureLabelCard sizes a two-line card so the second line never clips', () => {
  const card = measureLabelCard('UAL2476', 'B738 · FL340', 6);
  // bottom of the last baseline + descender must fit inside the card height
  assert.ok(card.subBase + 3 <= card.h, `subBase+desc ${card.subBase + 3} must fit in h ${card.h}`);
  assert.ok(card.idBase < card.subBase, 'id line sits above sub line');
  assert.ok(card.w >= 12 * 6, 'width covers the wider (sub) text');
  assert.equal(card.hasSec, true);
});

test('measureLabelCard collapses to a single line when there is no secondary', () => {
  const card = measureLabelCard('VEH-0001', '', 6);
  assert.equal(card.hasSec, false);
  assert.equal(card.subBase, 0);
  assert.ok(card.idBase + 3 <= card.h, 'single line + descender fits');
  const two = measureLabelCard('VEH-0001', 'VEH · 38mph', 6);
  assert.ok(two.h > card.h, 'two-line card is taller than one-line');
});

test('measureTrackLabel lays out callsign + altitude on one line', () => {
  const c = measureTrackLabel('WOLF21', '270', 6);
  assert.equal(c.hasMicro, true);
  assert.ok(c.microX > c.primaryX, 'altitude sits to the right of the callsign');
  assert.ok(c.baseline + 3 <= c.h, 'single line + descender fits inside height');
  assert.ok(c.w >= 6 * 6, 'width covers the callsign');
});

test('measureTrackLabel handles a missing altitude (callsign only)', () => {
  const c = measureTrackLabel('SAT-12345', '', 6);
  assert.equal(c.hasMicro, false);
  assert.ok(c.w >= 9 * 6, 'width covers the longer callsign');
});

test('callout cards avoid live HUD rectangles without rejecting edge-adjacent space', () => {
  const hud = [{ x: 100, y: 100, w: 80, h: 60 }];
  assert.equal(rectIntersectsAny({ x: 120, y: 80, w: 40, h: 40 }, hud), true);
  assert.equal(rectIntersectsAny({ x: 60, y: 100, w: 40, h: 20 }, hud), false);
  assert.equal(rectIntersectsAny({ x: 60, y: 100, w: 40, h: 20 }, hud, 1), true);
});

test('nearFarScale interpolates by distance and clamps to the near/far values', () => {
  // mirrors Cesium NearFarScalar(1000, 3.0, 8000000, 0.5) used by the flight billboards
  assert.equal(nearFarScale(1000, 1000, 3.0, 8000000, 0.5), 3.0);
  assert.equal(nearFarScale(8000000, 1000, 3.0, 8000000, 0.5), 0.5);
  assert.equal(nearFarScale(500, 1000, 3.0, 8000000, 0.5), 3.0);   // below near -> clamp
  assert.equal(nearFarScale(9e6, 1000, 3.0, 8000000, 0.5), 0.5);   // beyond far -> clamp
  const mid = nearFarScale((1000 + 8000000) / 2, 1000, 3.0, 8000000, 0.5);
  assert.ok(Math.abs(mid - 1.75) < 1e-6, `midpoint ~1.75, got ${mid}`);
});

// ---------------------------------------------------------------------------
// projectionRequestMatches — the steady-state reuse gate for the detection
// projection worker (see src/data/detection.js). A stored answer is consumed
// only when its request still describes the current frame: same stable cohort
// identities (order-independent), type/skipLabel unchanged, positions within
// PROJECTION_REUSE_EPSILON_M, same camera/occluder/viewport/view-projection.
// Every test below flips one input at a time and demands a mismatch.
// ---------------------------------------------------------------------------

const BASE_POS = { x: 1_000_000, y: 2_000_000, z: 3_000_000 };
const BASE_CAM = { x: -500_000, y: 0, z: 6_878_137 };
const BASE_VP = {
  vp0: 1, vp1: 0, vp2: 9, vp3: 0,
  vp4: 0, vp5: 1, vp6: 9, vp7: 0,
  vp8: 0, vp9: 0, vp10: 9, vp11: 0,
  vp12: 5, vp13: 7, vp14: 9, vp15: 1,
};
// Stable identity stand-in: tests key objects by `key`.
const identityOf = (o) => o.key;

function baseObjects() {
  return [
    { key: 101, type: 'AIR', skipLabel: true, position: { ...BASE_POS } },
    { key: 202, type: 'Vessel', skipLabel: false, position: { x: 4, y: 5, z: 6 } },
    { key: 303, type: 'Satellite', skipLabel: false, position: null },
  ];
}

// Stored answers: every object sits ≈200 km from the camera (ε ≈ 10 m by the
// relative rule), except key 303 which was occluded (no row → floor ε).
function baseResults(objects = baseObjects()) {
  return new Map(objects
    .filter((o) => o.key !== 303)
    .map((o) => [o.key, { id: o.key, visible: true, distance: 200_000 }]));
}

function baseRequest(objects = baseObjects()) {
  return {
    objectsById: new Map(objects.map((o) => [o.key, {
      id: o.key,
      type: o.type,
      skipLabel: Boolean(o.skipLabel),
      position: o.position ? { ...o.position } : null,
    }])),
    viewProjection: { ...BASE_VP },
    cameraPosition: { ...BASE_CAM },
    camPos: { ...BASE_CAM },
    occluderCameraPos: { ...BASE_CAM },
    width: 1280,
    height: 720,
  };
}

function matches(request, objects = baseObjects(), camPos = BASE_CAM, occluder = BASE_CAM, width = 1280, height = 720, vp = BASE_VP, results) {
  return projectionRequestMatches(
    request, objects, camPos, occluder, width, height, vp, identityOf,
    results === undefined ? baseResults(objects) : results,
  );
}

test('projectionRequestMatches: an identical frame matches — steady state reuses the worker answer', () => {
  assert.equal(matches(baseRequest()), true);
  // Fresh object/position objects with identical values must still match
  // (the frame rebuilds its cohort every draw).
  assert.equal(matches(baseRequest()), true);
});

test('projectionRequestMatches: cohort order may permute — identity, not index, correlates', () => {
  const request = baseRequest();
  const reordered = [baseObjects()[2], baseObjects()[1], baseObjects()[0]];
  assert.equal(matches(request, reordered), true,
    'a reordered cohort with identical members must still reuse the answer');
});

test('projectionRequestMatches: static-feed jitter matches, real movement does not', () => {
  const request = baseRequest();

  const jittered = baseObjects();
  // Caltrans-style refresh jitter, measured 0.2–8 m at orbital view — inside
  // the ≈10 m tolerance 200 km grants, worth ≈0.05 px on screen.
  jittered[1].position = { x: 4.2, y: 4.9, z: 6.2 };
  assert.equal(matches(request, jittered), true,
    'static-feed position jitter must not defeat reuse');

  const wobbled = baseObjects();
  // The worst measured CCTV wobble between refreshes (8.1 m).
  wobbled[1].position = { x: 4, y: 5 + 8.1, z: 6 };
  assert.equal(matches(request, wobbled), true,
    'the full measured static-feed wobble stays inside the relative tolerance');

  const moved = baseObjects();
  // A satellite crosses ≈125 m per 60 fps frame — far beyond 10 m.
  moved[1].position = { x: 4, y: 5 + 130, z: 6 };
  assert.equal(matches(request, moved), false,
    'an object that actually moved must invalidate the answer');
});

test('projectionRequestMatches: the tolerance collapses for near-camera objects', () => {
  const request = baseRequest();
  // key 202 answered at 2 km from the camera: ε = 5e-5 × 2000 = 0.1 m.
  const results = baseResults();
  results.set(202, { id: 202, visible: true, distance: 2_000 });

  const jittered = baseObjects();
  jittered[1].position = { x: 4.2, y: 4.9, z: 6.2 };  // 0.2–0.35 m off
  assert.equal(matches(request, jittered, BASE_CAM, BASE_CAM, 1280, 720, BASE_VP, results), false,
    'near-camera objects get the tight relative tolerance — no visible lag');

  const still = baseObjects();
  still[1].position = { x: 4.05, y: 5, z: 6.0 };      // 0.05 m off
  assert.equal(matches(request, still, BASE_CAM, BASE_CAM, 1280, 720, BASE_VP, results), true,
    'sub-floor drift (≤50 mm) still matches up close — ≈0.05 px on screen');
});

test('projectionRequestMatches: any single-object change breaks the match', () => {
  const req = baseRequest();

  const retyped = baseObjects();
  retyped[0].type = 'Vessel';
  assert.equal(matches(req, retyped), false, 'a retyped object must invalidate the answer');

  const retracked = baseObjects();
  retracked[2].skipLabel = true;
  assert.equal(matches(req, retracked), false, 'a skipLabel flip must invalidate the answer');

  const dropped = baseObjects().slice(0, 2);
  assert.equal(matches(req, dropped), false, 'a smaller cohort must invalidate the answer');

  const gained = [...baseObjects(), { key: 404, type: 'Vessel', skipLabel: false, position: { x: 1, y: 1, z: 1 } }];
  assert.equal(matches(req, gained), false, 'a larger cohort must invalidate the answer');

  const swapped = baseObjects();
  swapped[1] = { ...swapped[1], key: 999 };
  assert.equal(matches(req, swapped), false, 'an unknown identity must invalidate the answer');

  const nanned = baseObjects();
  nanned[1].position = { x: 4, y: NaN, z: 6 };
  assert.equal(matches(req, nanned), false, 'NaN positions can never match (NaN comparisons fail)');
});

test('projectionRequestMatches: camera, occluder, viewport, and view-projection changes break the match', () => {
  const req = baseRequest();

  assert.equal(matches(req, baseObjects(), { ...BASE_CAM, x: BASE_CAM.x + 1 }), false,
    'camera motion must invalidate the answer');
  assert.equal(matches(req, baseObjects(), BASE_CAM, { ...BASE_CAM, z: BASE_CAM.z + 1 }), false,
    'occluder motion must invalidate the answer');
  assert.equal(matches(req, baseObjects(), BASE_CAM, BASE_CAM, 1281, 720), false,
    'a resize must invalidate the answer');
  assert.equal(matches(req, baseObjects(), BASE_CAM, BASE_CAM, 1280, 721), false,
    'a height change must invalidate the answer');

  for (const key of VIEW_PROJECTION_KEYS) {
    const vp = { ...BASE_VP, [key]: BASE_VP[key] + 0.5 };
    assert.equal(matches(req, baseObjects(), BASE_CAM, BASE_CAM, 1280, 720, vp), false,
      `a ${key} coefficient change must invalidate the answer`);
  }
  assert.equal(VIEW_PROJECTION_KEYS.length, 12, 'the inventory covers the 12 consumed coefficients');
});

test('projectionRequestMatches: null/absent request never matches', () => {
  assert.equal(matches(null), false, 'no stored answer → synchronous fallback');
  assert.equal(matches(undefined), false);
});
