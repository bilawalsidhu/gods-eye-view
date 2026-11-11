import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMilitarySnapshotRenderer } from './snapshotRenderer.js';
import { createMotion } from './motion.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';

/**
 * A military snapshot renderer over the real motion part and fakes for the
 * rest: one contact per snapshot, the mesh floor probe and stale re-floor
 * recorded.
 */
function harness({ viewer = null, floor = null } = {}) {
  const iconIds = new Set();
  const meshCalls = [];
  const presented = [];
  const flightState = {
    _viewer: viewer,
    _icons: {
      has: (id) => iconIds.has(id),
      ids: () => [...iconIds],
      get count() {
        return iconIds.size;
      },
    },
    _positionHistory: new Map(),
    _groundSnap: { forget() {} },
    _models: new Map(),
    _trackedModel: null,
    _trackedIcao: null,
    records: { data: new Map() },
  };
  const parts = {
    rendering: {
      _modelOwnsVisual: () => false,
      _syncModelToClass() {},
      _groundSampleExclusions: () => ({ sets: ['fleet-models', 'icons'] }),
    },
    icons: {
      _iconIds: () => ['icon-primitive'],
      _addIcon: (id) => iconIds.add(id),
      _applyIconPresentation: (id) => presented.push(id),
      _planIcon() {},
      _forgetContact: (id) => iconIds.delete(id),
    },
  };
  const services = {
    camera: { trackedModelScaleForPixelCap: () => 1 },
    focus: {},
    groundFloor: {
      cachedGroundFloor: () => floor,
      GROUND_FLOOR_LIFT_M: 0.5,
    },
    meshFloor: {
      sampleMeshFloorCells: (scene, points, options) =>
        meshCalls.push({ scene, points, options }),
    },
  };
  parts.motion = createMotion({ flightState, services, parts, layer: {} });
  let fix = null;
  const records = {
    beginSnapshot() {},
    receive(aircraft) {
      const meta = {
        rawLon: aircraft.lon,
        rawLat: aircraft.lat,
        renderAltitudeM: aircraft.altM,
        speedMps: aircraft.speedMps,
        track: aircraft.track,
        onGround: false,
        klass: 'jet',
      };
      flightState.records.data.set(aircraft.id, meta);
      return { prevMeta: null, meta, groundFlipped: false, fixEpochMs: fix };
    },
    absence: () => 'retain',
  };
  const apply = createMilitarySnapshotRenderer({
    flightState,
    records,
    groundFloor: { warmGroundFloor() {}, cachedGroundFloor: () => floor },
    militaryRegistry: { registerMilitaryIcaos() {} },
    rendering: parts.rendering,
    tracking: {},
    motion: parts.motion,
    icons: parts.icons,
    queries: { _likelyLanded: () => false },
  });
  return {
    flightState,
    meshCalls,
    presented,
    apply(aircraft, fixEpochMs) {
      fix = fixEpochMs;
      return apply({
        observedAtMs: fixEpochMs,
        records: [aircraft],
        complete: true,
      });
    },
  };
}

const CONTACT = Object.freeze({
  id: 'ae1234',
  lon: -97.5,
  lat: 30.25,
  altM: 3000,
  speedMps: 200,
  track: 90,
});

test('the mesh floor probe takes the camera subpoint from the camera port', () => {
  const viewer = { scene: { id: 'scene' } };
  bindRenderer(viewer, {
    camera: fakeCameraPort({ pose: { lat: 30.5, lon: -97.25 } }).port,
  });
  const h = harness({ viewer });
  h.apply(CONTACT, 1_700_000_000_000);
  assert.equal(h.meshCalls.length, 1);
  const [call] = h.meshCalls;
  assert.equal(call.scene, viewer);
  assert.equal(call.options.viewerLat, 30.5);
  assert.equal(call.options.viewerLon, -97.25);
  assert.deepEqual(call.options.sets, ['fleet-models', 'icons']);
});

test('without a viewer the mesh floor probe has no camera subpoint', () => {
  const h = harness();
  h.apply(CONTACT, 1_700_000_000_000);
  assert.equal(h.meshCalls[0].options.viewerLat, undefined);
  assert.equal(h.meshCalls[0].options.viewerLon, undefined);
});

test('a fix appends to the history only when it advances a whole millisecond', () => {
  const h = harness();
  const t0 = 1_700_000_000_000;
  h.apply(CONTACT, t0);
  const history = h.flightState._positionHistory.get(CONTACT.id);
  assert.equal(history.length, 1);
  const [entry] = history;
  assert.equal(entry.epochMs, t0);
  assert.equal(entry.velocity, CONTACT.speedMps);
  assert.equal(entry.track, CONTACT.track);
  const expected = fromDegrees(CONTACT.lon, CONTACT.lat, CONTACT.altM);
  for (const axis of ['x', 'y', 'z'])
    assert.ok(Math.abs(entry.position[axis] - expected[axis]) < 1e-6, axis);
  // The same instant within its millisecond is a repeat, not a new fix.
  h.apply(CONTACT, t0 + 0.4);
  assert.equal(history.length, 1);
  h.apply({ ...CONTACT, lon: CONTACT.lon + 0.01 }, t0 + 1_000);
  assert.equal(history.length, 2);
  assert.equal(history[1].epochMs, t0 + 1_000);
  assert.notEqual(history[1].position, history[0].position);
});

test('a stale grounded contact is lifted onto its floor', () => {
  const h = harness({ floor: 100 });
  const t0 = 1_700_000_000_000;
  h.apply(CONTACT, t0);
  const parked = 'ae9999';
  const before = fromDegrees(-97.4, 30.2, 10);
  h.flightState.records.data.set(parked, {
    onGround: true,
    rawLat: 30.2,
    rawLon: -97.4,
    renderAltitudeM: 10,
  });
  const newest = { epochMs: t0, position: { ...before } };
  h.flightState._positionHistory.set(parked, [newest]);
  h.flightState._icons.has = (id) => id === parked || id === CONTACT.id;
  h.apply(CONTACT, t0 + 1_000);
  assert.equal(h.flightState.records.data.get(parked).renderAltitudeM, 100.5);
  const lifted = fromDegrees(-97.4, 30.2, 100.5);
  for (const axis of ['x', 'y', 'z'])
    assert.ok(Math.abs(newest.position[axis] - lifted[axis]) < 1e-6, axis);
  assert.ok(h.presented.includes(parked));
});
