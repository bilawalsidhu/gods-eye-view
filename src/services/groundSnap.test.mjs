import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGroundSnap } from './groundSnap.js';

const groundFloor = {
  cachedMeshFloor: () => null,
  meshFloorPreferred: () => false,
  reportValidatedMeshFloorCell: () => {},
};

/** A viewer whose ground is a loaded 3D tileset, counting height samples. */
function makeViewer() {
  const calls = { samples: 0 };
  const tileset = { show: true, tilesLoaded: true };
  const ground = { heightM: 1650 };
  return {
    calls,
    ground,
    scene: {
      primitives: { length: 1, get: () => tileset },
      sampleHeight() {
        calls.samples += 1;
        return ground.heightM;
      },
      globe: { getHeight: () => 1600 },
    },
  };
}

const atDenverAirport = Cesium.Cartesian3.fromDegrees(-104.6737, 39.8561, 0);

test('a clock that steps back opens a new sample window instead of denying samples until it catches up', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const viewer = makeViewer();
  const snap = createGroundSnap({ groundFloor });
  const icaos = ['a00001', 'a00002', 'a00003', 'a00004', 'a00005', 'a00006'];
  for (const icao of icaos) snap.heightFor(viewer, icao, atDenverAirport);
  assert.equal(viewer.calls.samples, 4, 'four samples per 250 ms window');
  t.mock.timers.setTime(1_000_000 - 60_000);
  for (const icao of icaos) snap.heightFor(viewer, icao, atDenverAirport);
  assert.equal(
    viewer.calls.samples,
    6,
    'the two denied aircraft sample in the new window',
  );
});

test('a retry backoff stamped before the clock stepped back does not wait for it to catch up', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000_000 });
  const viewer = makeViewer();
  const tileset = viewer.scene.primitives.get(0);
  const snap = createGroundSnap({ groundFloor });
  // A sample that finds no ground: a miss, backed off for 2 s.
  viewer.ground.heightM = undefined;
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  viewer.ground.heightM = 1650;
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  assert.equal(viewer.calls.samples, 1, 'the backoff holds');
  // The clock steps back an hour: the stamp is an hour off, past any backoff.
  t.mock.timers.setTime(10_000_000 - 3_600_000);
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), 1650);
  assert.equal(viewer.calls.samples, 2);
});

test('tiles still streaming earn no backoff: the first tick after they settle samples', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 20_000_000 });
  const viewer = makeViewer();
  const tileset = viewer.scene.primitives.get(0);
  const snap = createGroundSnap({ groundFloor });
  // The camera moves for 40 s: tiles stream the whole time, and the aircraft
  // asks on every tick.
  tileset.tilesLoaded = false;
  for (let ms = 0; ms <= 40_000; ms += 100) {
    t.mock.timers.setTime(20_000_000 + ms);
    assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  }
  assert.equal(viewer.calls.samples, 0, 'nothing samples while tiles stream');
  // The tiles settle: the very next tick samples, with no backoff to wait out.
  tileset.tilesLoaded = true;
  t.mock.timers.setTime(20_000_000 + 40_100);
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), 1650);
  assert.equal(viewer.calls.samples, 1);
});

test('a held measurement still answers while tiles stream', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 30_000_000 });
  const viewer = makeViewer();
  const tileset = viewer.scene.primitives.get(0);
  const snap = createGroundSnap({ groundFloor });
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), 1650);
  // Taxi 100 m: the snap is demoted to a held value and a resample is due,
  // but the tiles are streaming. The held value answers.
  tileset.tilesLoaded = false;
  const taxied = Cesium.Cartesian3.fromDegrees(-104.6737, 39.857, 0);
  assert.equal(snap.heightFor(viewer, 'a00001', taxied), 1650);
  assert.equal(viewer.calls.samples, 1);
  // Tiles settle: the resample runs at once and answers fresh.
  viewer.ground.heightM = 1652;
  tileset.tilesLoaded = true;
  assert.equal(snap.heightFor(viewer, 'a00001', taxied), 1652);
  assert.equal(viewer.calls.samples, 2);
});

test('a sample that finds no ground still backs off', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 40_000_000 });
  const viewer = makeViewer();
  const snap = createGroundSnap({ groundFloor });
  viewer.ground.heightM = undefined;
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  t.mock.timers.setTime(40_000_000 + 1_000);
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  assert.equal(viewer.calls.samples, 1, 'inside the 2 s backoff');
  t.mock.timers.setTime(40_000_000 + 2_001);
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  assert.equal(viewer.calls.samples, 2, 'retried once the backoff ended');
});

test('streaming tiles after a real miss leave its backoff as it was', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 50_000_000 });
  const viewer = makeViewer();
  const tileset = viewer.scene.primitives.get(0);
  const snap = createGroundSnap({ groundFloor });
  // One real miss: backed off for 2 s.
  viewer.ground.heightM = undefined;
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  // Tiles stream on every tick of that backoff and past it.
  tileset.tilesLoaded = false;
  for (let ms = 100; ms <= 3_000; ms += 100) {
    t.mock.timers.setTime(50_000_000 + ms);
    assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  }
  // They settle 3 s in: still the first 2 s backoff, not a doubled 4 s one.
  viewer.ground.heightM = 1650;
  tileset.tilesLoaded = true;
  t.mock.timers.setTime(50_000_000 + 3_100);
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), 1650);
  assert.equal(viewer.calls.samples, 2);
});
