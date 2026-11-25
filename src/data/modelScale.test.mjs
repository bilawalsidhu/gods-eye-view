import { readLayerSource } from '../testSupport/readLayerSource.mjs';
// Aircraft models draw LIFE SIZE: every aircraft layer takes its model and
// scale from the procedural fleet set (fleetModels.js), a type's published
// length over the model's built length. These pins keep that true — no layer
// carries a scale constant of its own (the giant-military-jet bug was one
// copied across layers) — and keep the trail and bracket anchors riding the
// transform chain Cesium draws the models with.
import { test } from 'node:test';
import * as Cesium from 'cesium';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  modelVisualAnchor,
  trailHeadStart,
  modelAnchorWorld,
  modelDrawnScale,
  gltfToPlacedAxes,
} from './modelVisualAnchor.js';
import { aircraftModelSpec } from './fleetModels.js';
import { FLEET_TRAIL_ANCHORS } from './fleetTrailAnchors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FLEET = path.join(ROOT, 'public', 'models', 'fleet');
const set = {
  catalog: JSON.parse(fs.readFileSync(path.join(FLEET, 'catalog.json'), 'utf8')),
  types: JSON.parse(fs.readFileSync(path.join(FLEET, 'types.json'), 'utf8')),
};

/** The JSON chunk of a GLB file. */
function glbJson(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${file}: not a GLB`);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, `${file}: first chunk not JSON`);
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
}

/** Every aircraft drawn at its type's size: no rendered radius outside what aircraft span. */
const WORLD_RADIUS_MIN_M = 2;
const WORLD_RADIUS_MAX_M = 60;

test('model-space anchors honor Cesium minimum-pixel computed scale', () => {
  const matrix = [
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 1, 0,
    100, 200, 300, 1,
  ];
  const result = { x: 0, y: 0, z: 0 };
  modelVisualAnchor(matrix, [2, 3, -4], 7, result);
  assert.deepEqual(result, { x: 79, y: 214, z: 272 });
});

test('every typed aircraft renders at its published length, a real-world aircraft size', () => {
  for (const map of [set.types.aircraft, set.types.helicopters]) {
    for (const [type, [model, length]] of Object.entries(map)) {
      const spec = aircraftModelSpec(set, { typeCode: type });
      assert.equal(spec.model, model, type);
      // Balloons and obstacles ('other') are built at their own size.
      const published = spec.category === 'other' ? set.catalog[model].length : length;
      assert.ok(Math.abs(spec.length - published) < 1e-9, `${type}: drawn ${spec.length} m, published ${published} m`);
      const radius = spec.nativeRadiusM * spec.scale;
      assert.ok(
        radius >= WORLD_RADIUS_MIN_M && radius <= WORLD_RADIUS_MAX_M,
        `${type}: rendered radius ${radius.toFixed(2)} m outside [${WORLD_RADIUS_MIN_M}, ${WORLD_RADIUS_MAX_M}]`,
      );
      // A grounded aircraft stands on its wheels: its origin the scaled
      // clearance above the ground, never below it.
      // A model built standing on its origin (a ground vehicle, a ground
      // station's mast: its lowest point at z 0) has no clearance.
      if (set.catalog[model].min[2] > -0.05)
        assert.ok(
          spec.clearanceM >= 0 && spec.clearanceM < 0.05 * spec.scale,
          `${type}: built standing, clearance ${spec.clearanceM}`,
        );
      else assert.ok(spec.clearanceM > 0, `${type}: clearance ${spec.clearanceM}`);
      assert.ok(spec.clearanceM < radius, `${type}: clearance larger than the aircraft`);
    }
  }
});

function normalBillboardScaleByDistance(sourceFile) {
  const src = readLayerSource(path.join(ROOT, sourceFile));
  const fn = src.match(/const NORMAL_SCALE_BY_DISTANCE = ([\s\S]*?\);)/);
  assert.ok(fn, `${sourceFile}: NORMAL_SCALE_BY_DISTANCE not found`);
  const scalar = fn[1].match(/near: (\d+),\s*nearValue: ([\d.]+),\s*far: (\d+),\s*farValue: ([\d.]+),?\s*\}/);
  assert.ok(scalar, `${sourceFile}: icon scale-by-distance not found`);
  return scalar.slice(1).map(Number);
}

const AIRCRAFT_LAYERS = [
  'src/layers/flights/rendering.js',
  'src/layers/military/rendering.js',
  'src/layers/localAdsb/models.js',
];

test('every aircraft layer takes its model and scale from the fleet set, no layer scale of its own', () => {
  for (const file of AIRCRAFT_LAYERS) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /\baircraftLayerModelSpec\b/, `${file}: models come from aircraftLayerModelSpec`);
    assert.match(source, /\bloadFleetModelSet\(|\bcreateAircraftModels\(/, `${file}: models are drawn from the loaded fleet set`);
    assert.doesNotMatch(source, /\bMODEL_SCALE\b|CLASS_SCALE_3D|\.glb['"]/, `${file}: no layer-owned model scale or asset`);
  }
});

// A PARKED contact is the case this decides. Grounded tracking starts a trail
// unconditionally, and on a contact that has not moved the last body point sits
// where the aircraft is — so the head segment ran from inside the model out to
// its own aft-belly anchor, straight through half the fuselage. The cut is on
// the segment's START, not its length (a length test hides trail that is
// genuinely in open air) and never on its END (clipping at the envelope stops a
// moving trail short of the aircraft). See trailHeadStart.
//
// A flat 1-D rig stands in for the world here: the model centre at the origin,
// the aft-belly anchor at its own measured station, and the last body point
// swept out along +x.
const TRAIL_RIG_MODELS = Object.keys(FLEET_TRAIL_ANCHORS);
const trailRigAt = (d) => ({ x: d, y: 0, z: 0 });
const trailRigCentre = trailRigAt(0);
/** The rig's world anchor: the model's own measured attachment point, laid out
 *  aft (+x) and vertically exactly as far as it really sits from the centre. */
function trailRigAnchor(name) {
  const native = FLEET_TRAIL_ANCHORS[name];
  return { x: native[0] || 0, y: native[1] || 0, z: 0 };
}
function trailRigEnvelope(name) {
  const { min, max } = set.catalog[name];
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
}
/** Visible length of the head segment the guard would have drawn, in metres. */
function drawnHeadLength(start, anchor, centre, envelope) {
  const from = trailHeadStart(start, anchor, centre, envelope, { x: 0, y: 0, z: 0 });
  if (!from) return 0;
  return Math.hypot(from.x - anchor.x, from.y - anchor.y, from.z - anchor.z);
}
// The review's repro, in the numbers it used: an airliner of 34.41 m envelope
// whose aft-belly anchor sits 24.09 m aft and 2.22 m down.
const AIRLINER_ENVELOPE = 34.41;
const AIRLINER_ANCHOR = { x: 24.0879, y: -2.2163, z: 0 };

test('a stationary contact draws no trail head, and a moving one draws all of it', () => {
  for (const name of TRAIL_RIG_MODELS) {
    const envelope = trailRigEnvelope(name);
    const anchor = trailRigAnchor(name);
    assert.equal(
      trailHeadStart(trailRigCentre, anchor, trailRigCentre, envelope, { x: 0, y: 0, z: 0 }), null,
      `${name}: a parked contact's head segment must not be drawn (envelope ${envelope.toFixed(2)} m)`,
    );
    const station = Math.hypot(anchor.x, anchor.y, anchor.z);
    assert.equal(drawnHeadLength(trailRigAt(station * 0.5), anchor, trailRigCentre, envelope), 0,
      `${name}: a segment that would run forward of its own anchor draws nothing`);
    const clear = trailRigAt(envelope * 1.01);
    assert.equal(trailHeadStart(clear, anchor, trailRigCentre, envelope, { x: 0, y: 0, z: 0 }), clear,
      `${name}: once the contact clears its own envelope the whole head must draw`);
  }
  for (const [d, why] of [
    [58, 'a fix 58 m aft is well outside the envelope and its segment must be drawn'],
    [7500, 'a jet covers ~7.5 km between fixes — that trail must never be shortened'],
    [300, 'even a slow 10 m/s taxi between 30 s fixes still draws its whole trail'],
  ]) {
    const start = trailRigAt(d);
    assert.equal(
      trailHeadStart(start, AIRLINER_ANCHOR, trailRigCentre, AIRLINER_ENVELOPE, { x: 0, y: 0, z: 0 }), start, why,
    );
  }
  const loose = trailRigAt(5);
  assert.equal(trailHeadStart(loose, AIRLINER_ANCHOR, null, 0, { x: 0, y: 0, z: 0 }), loose,
    'with no model envelope the whole segment always draws');
});

// The containment rule trailHeadStart replaced was BINARY: at a 34.41 m
// envelope a start at 34.40 m drew nothing and one at 34.42 m the whole
// 10.33 m segment. Sweep the start out through the boundary in small steps and
// require the VISIBLE LENGTH to move by no more than the step allows.
test('the trail head grows continuously across the envelope, never in one step', () => {
  for (const name of TRAIL_RIG_MODELS) {
    const envelope = trailRigEnvelope(name);
    const anchor = trailRigAnchor(name);
    const step = envelope / 400;
    let previous = 0;
    for (let d = 0; d <= envelope * 1.5; d += step) {
      const start = trailRigAt(d);
      const length = drawnHeadLength(start, anchor, trailRigCentre, envelope);
      assert.ok(
        length - previous <= step * 3 + 1e-9 && previous - length <= step * 3 + 1e-9,
        `${name}: the head jumped ${Math.abs(length - previous).toFixed(3)} m across a ` +
        `${step.toFixed(3)} m step at ${d.toFixed(3)} m`,
      );
      const full = Math.hypot(start.x - anchor.x, start.y - anchor.y, start.z - anchor.z);
      assert.ok(length <= full + 1e-9,
        `${name}: drew ${length.toFixed(3)} m of a ${full.toFixed(3)} m segment at ${d.toFixed(3)} m`);
      previous = length;
    }
  }
  const inside = drawnHeadLength(trailRigAt(34.40), AIRLINER_ANCHOR, trailRigCentre, AIRLINER_ENVELOPE);
  const outside = drawnHeadLength(trailRigAt(34.42), AIRLINER_ANCHOR, trailRigCentre, AIRLINER_ENVELOPE);
  assert.ok(outside > 10, `the segment 34.42 m aft is ~10.3 m long and must draw (${outside})`);
  assert.ok(Math.abs(outside - inside) < 0.1,
    `crossing the envelope by 2 cm moved the trail ${Math.abs(outside - inside).toFixed(3)} m`);
  const flap = [34.40, 34.42, 34.40, 34.43, 34.39].map(
    (d) => drawnHeadLength(trailRigAt(d), AIRLINER_ANCHOR, trailRigCentre, AIRLINER_ENVELOPE));
  assert.ok(Math.max(...flap) - Math.min(...flap) < 0.1, 'an in/out/in flap must not strobe the trail');
  assert.ok(Math.min(...flap) > 10, 'every visit in that flap is a real ~10 m segment');
});

// The anchor is expressed in the model's own axes, and it only lands where it
// is meant to if it rides the SAME transform chain Cesium renders the model
// with (`modelMatrix x components.transform x axisCorrection`). A table stored
// after half of Cesium's axis correction once put the aft offset on the
// rendered model's LATERAL axis — invisible at a single heading. So this sweeps
// headings and every fleet anchor, and asserts the anchor lies in the model's
// longitudinal/vertical plane, aft and at its own height. The anchor is drawn
// at a scale other than 1, because a scale of 1 leaves both numbers the pin
// asserts at the raw table values, which is the answer a dropped scale gives.
const TRAIL_DRAWN_SCALE = 2;
function headingAxes(origin, headingDeg) {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin, Cesium.Ellipsoid.WGS84, new Cesium.Matrix4());
  const axis = (i) => {
    const c = Cesium.Matrix4.getColumn(enu, i, new Cesium.Cartesian4());
    return Cesium.Cartesian3.normalize(new Cesium.Cartesian3(c.x, c.y, c.z), new Cesium.Cartesian3());
  };
  const east = axis(0); const north = axis(1); const vertical = axis(2);
  const rad = Cesium.Math.toRadians(headingDeg);
  const lengthwise = Cesium.Cartesian3.normalize(Cesium.Cartesian3.add(
    Cesium.Cartesian3.multiplyByScalar(north, Math.cos(rad), new Cesium.Cartesian3()),
    Cesium.Cartesian3.multiplyByScalar(east, Math.sin(rad), new Cesium.Cartesian3()),
    new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const lateral = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(lengthwise, vertical, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  return { lengthwise, vertical, lateral };
}

test('the trail anchor rides the rendered longitudinal axis at every heading', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 3000);
  for (const headingDeg of [0, 45, 90, 180, 270, 315]) {
    const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(headingDeg), 0, 0);
    const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
      position, hpr, Cesium.Ellipsoid.WGS84, undefined, new Cesium.Matrix4(),
    );
    const origin = Cesium.Matrix4.getTranslation(modelMatrix, new Cesium.Cartesian3());
    const { lengthwise, vertical, lateral } = headingAxes(origin, headingDeg);
    for (const [name, anchor] of Object.entries(FLEET_TRAIL_ANCHORS)) {
      const world = modelAnchorWorld(modelMatrix, anchor, TRAIL_DRAWN_SCALE, new Cesium.Cartesian3());
      const offset = Cesium.Cartesian3.subtract(world, origin, new Cesium.Cartesian3());
      const where = `${name} @ heading ${headingDeg}`;
      const side = Cesium.Cartesian3.dot(offset, lateral);
      assert.ok(Math.abs(side) < 1e-4, `${where}: the anchor must have NO lateral component (got ${side.toFixed(4)} m)`);
      const along = Cesium.Cartesian3.dot(offset, lengthwise);
      const up = Cesium.Cartesian3.dot(offset, vertical);
      const expectedAlong = anchor[0] * TRAIL_DRAWN_SCALE;
      const expectedUp = anchor[1] * TRAIL_DRAWN_SCALE;
      assert.ok(Math.abs(along - expectedAlong) < 1e-4,
        `${where}: longitudinal offset ${along.toFixed(4)} vs ${expectedAlong.toFixed(4)}`);
      assert.ok(Math.abs(up - expectedUp) < 1e-4,
        `${where}: vertical offset ${up.toFixed(4)} vs ${expectedUp.toFixed(4)}`);
    }
  }
});

// A hovering helicopter's course is ill-defined. The anchor is a model-space
// offset, so an arbitrary heading still puts it on the hull's centreline.
test('a hovering rotorcraft anchors aft of its own hull, whatever its heading', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 300);
  const spec = aircraftModelSpec(set, { typeCode: 'H60' });
  const anchor = spec.trailAnchorNative;
  assert.ok(anchor[0] > 0, 'the rotorcraft anchor sits aft');
  for (const headingDeg of [0, 137.5, 271.9]) {
    const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(headingDeg), 0, 0);
    const matrix = Cesium.Transforms.headingPitchRollToFixedFrame(
      position, hpr, Cesium.Ellipsoid.WGS84, undefined, new Cesium.Matrix4());
    const origin = Cesium.Matrix4.getTranslation(matrix, new Cesium.Cartesian3());
    const world = modelAnchorWorld(matrix, anchor, spec.scale, new Cesium.Cartesian3());
    const { lateral } = headingAxes(origin, headingDeg);
    const side = Cesium.Cartesian3.dot(
      Cesium.Cartesian3.subtract(world, origin, new Cesium.Cartesian3()), lateral);
    assert.ok(Math.abs(side) < 1e-4,
      `${spec.model} @ heading ${headingDeg}: hovering rotorcraft anchor drifted sideways by ${side.toFixed(4)} m`);
  }
});

// The glTF axis turn the anchors ride is the one the Cesium renderer draws
// models with (`Model.fromGltfAsync`'s defaults: Y up, Z forward), and no
// fleet model carries a root transform of its own that the renderer would add
// to the chain.
test('anchors turn glTF axes as the Cesium renderer draws models', () => {
  const correction = Cesium.Matrix4.multiplyTransformation(
    Cesium.Axis.Y_UP_TO_Z_UP, Cesium.Axis.Z_UP_TO_X_UP, new Cesium.Matrix4());
  for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [3.5, -2, 7]]) {
    const drawn = Cesium.Matrix4.multiplyByPoint(
      correction, new Cesium.Cartesian3(...v), new Cesium.Cartesian3());
    const turned = gltfToPlacedAxes(v);
    assert.deepEqual([drawn.x, drawn.y, drawn.z].map((n) => +n.toFixed(12)), turned.map((n) => +n.toFixed(12)));
  }
  for (const [name, entry] of Object.entries(set.catalog)) {
    const gltf = glbJson(path.join(FLEET, entry.file));
    assert.ok(!gltf.extensionsUsed?.includes('CESIUM_RTC'), `${name}: no root transform of its own`);
  }
});

// The drawn scale follows the draw contract's pixel rule, which the Cesium
// renderer implements as Model.computedScale: the bounding sphere's pixel
// size at its depth less its radius, raised to minPixelSize.
test('a model is drawn at its scale until the pixel floor raises it', () => {
  const pose = { position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, fovy: Math.PI / 3 };
  const base = { scale: 1, minPixelSize: 24, radiusM: 30, pose, viewportHeightPx: 1000 };
  // Near: 60 m across fills hundreds of pixels.
  assert.equal(modelDrawnScale({ ...base, center: { x: 0, y: 0, z: 500 } }), 1);
  // Far: 100 km away, 24 px of a 30 m-radius sphere.
  const depth = 100_000;
  const mpp = (2 * (depth - 30) * Math.tan(Math.PI / 6)) / 1000;
  const raised = modelDrawnScale({ ...base, center: { x: 0, y: 0, z: depth } });
  assert.ok(Math.abs(raised - (24 * mpp) / 60) < 1e-9, `raised to ${raised}`);
  // Depth along the view direction, not straight-line distance: off to one
  // side at the same depth, it is raised the same.
  assert.equal(modelDrawnScale({ ...base, center: { x: 40_000, y: 0, z: depth } }), raised);
  // The sphere's size is capped at the drawing buffer's larger side in its own
  // pixels: at a pixel ratio of 2 a 500 CSS px viewport is 1000 px across, so
  // a sphere 600 CSS px wide is not raised.
  const close = { ...base, minPixelSize: 600, viewportHeightPx: 500, center: { x: 0, y: 0, z: 60 } };
  assert.equal(modelDrawnScale({ ...close, pixelRatio: 2 }), 1);
  assert.ok(modelDrawnScale(close) < 1, 'at a pixel ratio of 1 the cap is 500 px');
  // maxScale caps it, and the sphere it is measured by is at the capped scale.
  assert.equal(modelDrawnScale({ ...base, maxScale: 2, center: { x: 0, y: 0, z: depth } }), 2);
  const fromCapped = modelDrawnScale({ ...base, scale: 5, maxScale: 3, minPixelSize: 400, center: { x: 0, y: 0, z: depth } });
  assert.equal(fromCapped, 3, 'raised past maxScale, then capped');
  const big = modelDrawnScale({ ...base, scale: 5, maxScale: 1e9, minPixelSize: 4000, viewportHeightPx: 1000, viewportWidthPx: 5000, center: { x: 0, y: 0, z: depth } });
  assert.ok(Math.abs(big - (4000 * ((2 * (depth - 150) * Math.tan(Math.PI / 6)) / 1000)) / 60) < 1e-9, `raised from the sphere at scale 5: ${big}`);
  assert.equal(modelDrawnScale({ ...base, pose: null, center: { x: 0, y: 0, z: depth } }), 1);
});

test('civilian and military globe-view aircraft retain the established 3.0 near scale and 0.5 floor', () => {
  for (const [name, source] of [
    ['flights', 'src/data/flights.js'],
    ['military', 'src/data/militaryFlights.js'],
  ]) {
    assert.deepEqual(
      normalBillboardScaleByDistance(source),
      [1000, 3, 8000000, 0.5],
      `${name}: owner-established close sizing and the orbital floor must remain readable`,
    );
  }
});

test('a layer asking every tick gets one cached spec per type and category', async () => {
  const { aircraftLayerModelSpec } = await import('../layers/flights/modelSpec.js');
  const a = aircraftLayerModelSpec({ typeCode: 'A320' }, set);
  assert.equal(aircraftLayerModelSpec({ typeCode: 'A320' }, set), a);
  assert.notEqual(aircraftLayerModelSpec({ typeCode: 'B744' }, set), a);
  assert.ok(Object.isFrozen(a));
});

test('an airport vehicle is cached by its callsign; other aircraft by type and category only', async () => {
  const { aircraftLayerModelSpec, aircraftModelSpecCacheKey } = await import(
    '../layers/flights/modelSpec.js'
  );
  const tender = aircraftLayerModelSpec(
    { typeCode: 'ZVEH', callsign: 'FIRE 2' },
    set,
  );
  const car = aircraftLayerModelSpec(
    { typeCode: 'ZVEH', callsign: 'LEADER 7' },
    set,
  );
  assert.equal(tender.model, 'fire_truck');
  assert.equal(car.model, 'car');
  assert.equal(
    aircraftModelSpecCacheKey({ typeCode: 'A320', callsign: 'BAW1' }, set),
    aircraftModelSpecCacheKey({ typeCode: 'A320', callsign: 'DLH2' }, set),
  );
  assert.notEqual(
    aircraftModelSpecCacheKey({ typeCode: 'ZVEH', callsign: 'FIRE 2' }, set),
    aircraftModelSpecCacheKey({ typeCode: 'ZVEH', callsign: 'LEADER 7' }, set),
  );
  // Keyed by the rule matched, not the callsign: at most one entry per rule
  // and one for the type's own model.
  assert.equal(
    aircraftModelSpecCacheKey({ typeCode: 'ZVEH', callsign: 'FIRE 2' }, set),
    aircraftModelSpecCacheKey({ typeCode: 'ZVEH', callsign: 'FIRE 9' }, set),
  );
  assert.equal(
    aircraftModelSpecCacheKey({ typeCode: 'ZVEH', callsign: 'LEADER 7' }, set),
    aircraftModelSpecCacheKey({ typeCode: 'ZVEH', callsign: 'ASD' }, set),
  );
  assert.equal(
    aircraftLayerModelSpec({ typeCode: 'ZVEH', callsign: 'FIRE 9' }, set),
    tender,
  );
});
