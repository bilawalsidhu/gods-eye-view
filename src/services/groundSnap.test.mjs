import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGroundSnap } from './groundSnap.js';
import { bindRenderer } from '../render/rendererOf.js';

const groundFloor = {
  cachedMeshFloor: () => null,
  meshFloorPreferred: () => false,
  reportValidatedMeshFloorCell: () => {},
};

/** A viewer whose ground is a loaded 3D tileset, counting height samples. */
function makeViewer() {
  const calls = { samples: 0 };
  const tileset = { show: true, tilesLoaded: true };
  return {
    calls,
    scene: {
      primitives: { length: 1, get: () => tileset },
      sampleHeight() {
        calls.samples += 1;
        return 1650;
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
  // Tiles still streaming: a miss, backed off for 2 s.
  tileset.tilesLoaded = false;
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  tileset.tilesLoaded = true;
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), null);
  assert.equal(viewer.calls.samples, 0, 'the backoff holds');
  // The clock steps back an hour: the stamp is an hour off, past any backoff.
  t.mock.timers.setTime(10_000_000 - 3_600_000);
  assert.equal(snap.heightFor(viewer, 'a00001', atDenverAirport), 1650);
  assert.equal(viewer.calls.samples, 1);
});

test('draw-set exclusions sample through the renderer’s query port', () => {
  const viewer = makeViewer();
  const asked = [];
  bindRenderer(viewer, {
    query: {
      sampleHeightNow(point, options) {
        asked.push({ point, options });
        return 1655;
      },
    },
  });
  const snap = createGroundSnap({ groundFloor });
  assert.equal(
    snap.heightFor(viewer, 'a00001', atDenverAirport, {
      sets: ['mine:models'],
    }),
    1655,
  );
  assert.equal(viewer.calls.samples, 0, 'not the scene’s own sample');
  assert.deepEqual(asked[0].options, { exclude: ['mine:models'] });
  assert.ok(Math.abs(asked[0].point.lon + 104.6737) < 1e-6);
});
