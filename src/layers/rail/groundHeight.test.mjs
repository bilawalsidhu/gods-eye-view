/**
 * Where trains and the selected trip's stops stand while their floor cell is
 * cold: a train on the floor it last stood on (or a neighbouring cell's), a
 * stop on the ellipsoid only until its cell is warm, and the cell is warmed
 * off the frame path. Seen on Google's photorealistic tiles, where a train
 * running onto unsampled cells dropped about 150 m under its line near
 * Chicago, then jumped back once a cell warmed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  BOSTON,
  railLayerHarness as harness,
  railTrain as train,
} from '../../testSupport/railLayerHarness.mjs';
import {
  COLD_CELL_FLUSH_MS,
  COLD_CELL_RETRY_MS,
  COLD_CELLS_PER_FLUSH,
  FLOOR_CELLS_BURST,
  FLOOR_CELLS_PER_MINUTE,
  FLOOR_WARM_MAX_DIST_KM,
  STOP_REFRESH_MS,
  TRACK_MAX_GRADE,
  TRACK_PRIOR_BELOW_M,
  TRACK_SAMPLE_MAX_AGE_MS,
  TRACK_SAMPLE_MAX_CAMERA_M,
  TRACK_SAMPLE_REFRESH_MS,
  TRACK_SAMPLE_RETRY_MS,
  railTrainKey,
} from './policy.js';
import { RAIL_STOP_OVERLAY_SOURCE_ID } from './stopLabels.js';

const CHICAGO = { lat: 41.8789, lon: -87.6359 };
const WEST = { lat: 41.8789, lon: -87.7 };
/** A camera low enough over Chicago for the mesh to be sampled. */
const LOW_M = 2_000;
const cellKey = ({ lat, lon }) =>
  `${Math.round(lat * 1000)},${Math.round(lon * 1000)}`;

/** A floor service: warm cells by 0.001° key, and the warm requests made. */
function floorService({ neighbour = null } = {}) {
  const warm = new Map();
  const requested = [];
  const near = { m: neighbour, coarseCalls: 0 };
  return {
    warm,
    requested,
    near,
    ground: {
      GROUND_FLOOR_LIFT_M: 1.5,
      cachedGroundFloor: (lat, lon) => warm.get(cellKey({ lat, lon })) ?? null,
      warmGroundFloor(cells) {
        requested.push(...cells.map(cellKey));
      },
      coarseFloorCoord(lat, lon) {
        near.coarseCalls += 1;
        return {
          lat: Math.round(lat * 1000) / 1000,
          lon: Math.round(lon * 1000) / 1000,
        };
      },
      neighborFloorM: () => near.m,
    },
  };
}

/**
 * Photorealistic tiles in the scene: a shown tileset whose streaming state
 * the test sets, and the mesh height every probe reads (recorded).
 */
function photoreal(app, { loaded = true, height = 158 } = {}) {
  const tileset = { show: true, tilesLoaded: loaded };
  const mesh = { height, probes: [] };
  app.viewer.scene.primitives.add(tileset);
  app.viewer.scene.sampleHeight = (carto) => {
    mesh.probes.push({
      lat: (carto.latitude * 180) / Math.PI,
      lon: (carto.longitude * 180) / Math.PI,
    });
    return mesh.height;
  };
  return { tileset, mesh };
}

test('a train on a cold cell keeps its last floor, and the cell is warmed', async (t) => {
  const floors = floorService();
  floors.warm.set(cellKey(CHICAGO), 150);
  const app = harness(t, { at: CHICAGO, ground: floors.ground });
  await app.enable();
  const { heightFor } = app.parts().rendering;
  const train = {};
  assert.equal(heightFor(CHICAGO.lat, CHICAGO.lon, train), 151.5);
  // West of the city, not sampled yet: still on the Chicago floor.
  assert.equal(heightFor(WEST.lat, WEST.lon, train), 151.5);
  assert.deepEqual(floors.requested, []);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.deepEqual(floors.requested, [cellKey(WEST)]);
  // Every frame reads it again; it is asked for once until the retry time.
  heightFor(WEST.lat, WEST.lon, train);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.equal(floors.requested.length, 1);
  t.mock.timers.tick(COLD_CELL_RETRY_MS);
  heightFor(WEST.lat, WEST.lon, train);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.equal(floors.requested.length, 2);
  // Once warm, its own floor.
  floors.warm.set(cellKey(WEST), 160);
  assert.equal(heightFor(WEST.lat, WEST.lon, train), 161.5);
  // A point with no floor of its own to keep is on the ellipsoid.
  assert.equal(heightFor(41.9, -87.8), 0);
});

test('a warm neighbouring cell comes before the last floor', async (t) => {
  const floors = floorService({ neighbour: 170 });
  floors.warm.set(cellKey(CHICAGO), 150);
  const app = harness(t, { at: CHICAGO, ground: floors.ground });
  await app.enable();
  const { heightFor } = app.parts().rendering;
  const train = {};
  heightFor(CHICAGO.lat, CHICAGO.lon, train);
  assert.equal(heightFor(WEST.lat, WEST.lon, train), 171.5);
});

test('a train gliding across a cold cell asks for its coarse cell once', async (t) => {
  const floors = floorService({ neighbour: 170 });
  const app = harness(t, { at: CHICAGO, ground: floors.ground });
  await app.enable();
  const { heightFor } = app.parts().rendering;
  const train = {};
  floors.near.coarseCalls = 0;
  // Frames inside one 0.001° cell (centred on WEST), then the next cell.
  for (let i = 0; i < 20; i += 1)
    assert.equal(heightFor(WEST.lat, WEST.lon + i * 0.00002, train), 171.5);
  assert.equal(floors.near.coarseCalls, 1);
  heightFor(WEST.lat, WEST.lon + 0.001, train);
  assert.equal(floors.near.coarseCalls, 2);
});

test('from far above, cold cells are not warmed', async (t) => {
  const floors = floorService();
  const app = harness(t, {
    at: CHICAGO,
    altitude: 500_000,
    ground: floors.ground,
  });
  await app.enable();
  app.parts().rendering.heightFor(WEST.lat, WEST.lon, {});
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.deepEqual(floors.requested, []);
});

test('a high floor next to the line is a bump, not a jump (grade limit)', async (t) => {
  const floors = floorService();
  floors.warm.set(cellKey(CHICAGO), 150);
  // The next cell's floor was read on a roof 30 m above the rails.
  const NEXT = { lat: CHICAGO.lat, lon: CHICAGO.lon + 0.0013 };
  floors.warm.set(cellKey(NEXT), 180);
  const app = harness(t, { at: CHICAGO, ground: floors.ground });
  await app.enable();
  const { displayHeightFor } = app.parts().rendering;
  const train = { key: 'k1' };
  assert.equal(displayHeightFor(train, CHICAGO.lat, CHICAGO.lon), 151.5);
  const drawn = train.drawnHeight;
  const movedM = 0.0013 * 111_320 * Math.cos((CHICAGO.lat * Math.PI) / 180);
  const next = displayHeightFor(train, NEXT.lat, NEXT.lon);
  assert.ok(next > 151.5, 'climbs toward the higher floor');
  assert.ok(
    next <= 151.5 + TRACK_MAX_GRADE * movedM + 0.01,
    `no faster than the grade limit (${next})`,
  );
  // The drawn height is kept in place, not rebuilt every frame.
  assert.equal(train.drawnHeight, drawn);
  assert.equal(drawn.h, next);
});

test('a real floor replacing the ellipsoid fallback is taken at once', async (t) => {
  const floors = floorService();
  const app = harness(t, { at: CHICAGO, ground: floors.ground });
  await app.enable();
  const { displayHeightFor } = app.parts().rendering;
  const train = { key: 'k2' };
  assert.equal(displayHeightFor(train, WEST.lat, WEST.lon), 0);
  floors.warm.set(cellKey(WEST), 160);
  assert.equal(displayHeightFor(train, WEST.lat, WEST.lon), 161.5);
});

test('a neighbouring floor replacing the ellipsoid is taken at once', async (t) => {
  const floors = floorService();
  const app = harness(t, { at: CHICAGO, ground: floors.ground });
  await app.enable();
  const { displayHeightFor } = app.parts().rendering;
  const train = { key: 'k2n' };
  assert.equal(displayHeightFor(train, WEST.lat, WEST.lon), 0);
  // Its own cell is still cold, a neighbour's is warm: no 5% ramp up from
  // the ellipsoid, 150 m under the mesh.
  floors.near.m = 170;
  const step = { lat: WEST.lat, lon: WEST.lon + 0.0002 };
  assert.equal(displayHeightFor(train, step.lat, step.lon), 171.5);
  // Between two fallbacks, the grade limit still holds.
  floors.near.m = 190;
  const after = displayHeightFor(train, step.lat, step.lon + 0.0002);
  assert.ok(after > 171.5 && after < 180, `ramps (${after})`);
});

test('on photorealistic tiles the mesh is sampled on the line itself', async (t) => {
  const floors = floorService();
  floors.warm.set(cellKey(WEST), 150);
  const app = harness(t, {
    at: CHICAGO,
    altitude: LOW_M,
    ground: floors.ground,
  });
  await app.enable();
  const { mesh } = photoreal(app);
  const { displayHeightFor } = app.parts().rendering;
  const train = { key: 'k3' };
  // The exact point on the track, not the floor cell's centre.
  const ON_TRACK = { lat: WEST.lat + 0.00031, lon: WEST.lon - 0.00027 };
  assert.equal(displayHeightFor(train, ON_TRACK.lat, ON_TRACK.lon), 151.5);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.equal(mesh.probes.length, 1);
  assert.ok(Math.abs(mesh.probes[0].lat - ON_TRACK.lat) < 1e-9);
  assert.ok(Math.abs(mesh.probes[0].lon - ON_TRACK.lon) < 1e-9);
  // The sample is the target now; the drawn height settles toward it.
  t.mock.timers.tick(20_000);
  assert.equal(displayHeightFor(train, ON_TRACK.lat, ON_TRACK.lon), 159.5);
  // Not asked again for the same bucket until the refresh time.
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.equal(mesh.probes.length, 1);
});

test('a sample far from the floor under it is a coarse tile and is dropped', async (t) => {
  const floors = floorService();
  floors.warm.set(cellKey(WEST), 150);
  const app = harness(t, {
    at: CHICAGO,
    altitude: LOW_M,
    ground: floors.ground,
  });
  await app.enable();
  const { mesh } = photoreal(app, { height: 400 });
  const { displayHeightFor } = app.parts().rendering;
  const train = { key: 'k4' };
  displayHeightFor(train, WEST.lat, WEST.lon);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS + TRACK_SAMPLE_RETRY_MS);
  assert.equal(mesh.probes.length, 1);
  assert.equal(displayHeightFor(train, WEST.lat, WEST.lon), 151.5);
  // A valley floor read under a viaduct, well below the floor: dropped too.
  // (The next track bucket along, in the same floor cell.)
  const viaduct = { key: 'k4v' };
  const NEAR = { lat: WEST.lat, lon: WEST.lon - 0.0004 };
  mesh.height = 150 - TRACK_PRIOR_BELOW_M - 5;
  displayHeightFor(viaduct, NEAR.lat, NEAR.lon);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.ok(mesh.probes.some((probe) => Math.abs(probe.lon - NEAR.lon) < 1e-9));
  t.mock.timers.tick(60_000);
  assert.equal(displayHeightFor(viaduct, NEAR.lat, NEAR.lon), 151.5);
});

test('from far above, the line is not sampled', async (t) => {
  const floors = floorService();
  floors.warm.set(cellKey(WEST), 150);
  const app = harness(t, {
    at: CHICAGO,
    altitude: 500_000,
    ground: floors.ground,
  });
  await app.enable();
  const { mesh } = photoreal(app, { height: 151 });
  app.parts().rendering.displayHeightFor({ key: 'k5' }, WEST.lat, WEST.lon);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.equal(mesh.probes.length, 0);
});

test('the line is sampled only from a low camera, once the tiles are loaded', async (t) => {
  const floors = floorService();
  floors.warm.set(cellKey(WEST), 150);
  // 20 km up the tiles near the camera are coarse, loaded or not.
  const app = harness(t, {
    at: CHICAGO,
    altitude: 20_000,
    ground: floors.ground,
  });
  await app.enable();
  const { tileset, mesh } = photoreal(app);
  const { displayHeightFor } = app.parts().rendering;
  const train = { key: 'k6' };
  displayHeightFor(train, WEST.lat, WEST.lon);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.equal(mesh.probes.length, 0, 'not from 20 km');
  // Low enough, but the tiles are still streaming.
  await app.moveCamera({ altitude: 150 + TRACK_SAMPLE_MAX_CAMERA_M - 100 });
  tileset.tilesLoaded = false;
  t.mock.timers.tick(TRACK_SAMPLE_RETRY_MS);
  displayHeightFor(train, WEST.lat, WEST.lon);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.equal(mesh.probes.length, 0, 'not while streaming');
  tileset.tilesLoaded = true;
  t.mock.timers.tick(TRACK_SAMPLE_RETRY_MS);
  displayHeightFor(train, WEST.lat, WEST.lon);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.equal(mesh.probes.length, 1);
});

test('a sample read from lower down replaces one from higher up; an old one goes', async (t) => {
  const floors = floorService();
  floors.warm.set(cellKey(WEST), 150);
  const app = harness(t, {
    at: CHICAGO,
    altitude: 4_000,
    ground: floors.ground,
  });
  await app.enable();
  const { mesh } = photoreal(app, { height: 140 });
  const { displayHeightFor } = app.parts().rendering;
  const train = { key: 'k7' };
  /** Read the bucket again, and let the drawn height settle on its target. */
  const settled = () => {
    displayHeightFor(train, WEST.lat, WEST.lon);
    t.mock.timers.tick(COLD_CELL_FLUSH_MS);
    t.mock.timers.tick(60_000);
    return displayHeightFor(train, WEST.lat, WEST.lon);
  };
  // From 4 km, a coarse tile 10 m low: inside the bounds, so kept for now.
  assert.equal(settled(), 141.5);
  // From 1 km the tiles are finer: the new reading replaces it.
  await app.moveCamera({ altitude: 1_000 });
  mesh.height = 158;
  t.mock.timers.tick(TRACK_SAMPLE_REFRESH_MS);
  assert.equal(settled(), 159.5);
  // Back up at 4.5 km, the coarse reading does not win over it...
  await app.moveCamera({ altitude: 4_500 });
  mesh.height = 140;
  const reads = mesh.probes.length;
  t.mock.timers.tick(TRACK_SAMPLE_REFRESH_MS);
  assert.equal(settled(), 159.5);
  assert.equal(mesh.probes.length, reads + 1, 'it was read again');
  // ...until the one from lower down is old.
  t.mock.timers.tick(TRACK_SAMPLE_MAX_AGE_MS);
  assert.equal(settled(), 141.5);
});

test('disabling the layer drops the cells and samples still queued', async (t) => {
  const floors = floorService();
  floors.warm.set(cellKey(CHICAGO), 150);
  const app = harness(t, {
    at: CHICAGO,
    altitude: LOW_M,
    ground: floors.ground,
  });
  await app.enable();
  const { mesh } = photoreal(app);
  const { heightFor, displayHeightFor } = app.parts().rendering;
  heightFor(WEST.lat, WEST.lon, {});
  displayHeightFor({ key: 'k8' }, CHICAGO.lat, CHICAGO.lon);
  app.layer.disable(app.viewer);
  t.mock.timers.tick(COLD_CELL_FLUSH_MS * 3);
  assert.deepEqual(floors.requested, []);
  assert.equal(mesh.probes.length, 0);
  // Enabled again, the cell is asked for at once, not after a retry time.
  await app.enable();
  heightFor(WEST.lat, WEST.lon, {});
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.deepEqual(floors.requested, [cellKey(WEST)]);
});

test('trains far from the camera do not warm floor cells', async (t) => {
  const floors = floorService();
  const app = harness(t, { at: CHICAGO, ground: floors.ground });
  await app.enable();
  const { heightFor } = app.parts().rendering;
  // Well past FLOOR_WARM_MAX_DIST_KM from the camera over Chicago.
  const FAR = {
    lat: CHICAGO.lat,
    lon: CHICAGO.lon + (FLOOR_WARM_MAX_DIST_KM + 20) / 83,
  };
  heightFor(FAR.lat, FAR.lon, {});
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  assert.deepEqual(floors.requested, []);
});

/**
 * Cold cells for hundreds of trains near the camera, `rounds` flushes of
 * them; the cells the floor service was asked for.
 */
function crowd(t, app, floors, rounds) {
  const { heightFor } = app.parts().rendering;
  let asked = 0;
  for (let round = 0; round < rounds; round += 1) {
    for (let i = 0; i < 100; i += 1) {
      const n = round * 100 + i;
      heightFor(
        CHICAGO.lat + (n % 60) * 0.002,
        CHICAGO.lon + Math.floor(n / 60) * 0.002,
        {},
      );
    }
    const before = floors.requested.length;
    t.mock.timers.tick(COLD_CELL_FLUSH_MS);
    const flushed = floors.requested.length - before;
    assert.ok(flushed <= COLD_CELLS_PER_FLUSH, `one flush ${flushed}`);
    asked += flushed;
  }
  return asked;
}

test('floor warming stays within the shared terrain budget', async (t) => {
  const floors = floorService();
  const app = harness(t, { at: CHICAGO, ground: floors.ground });
  await app.enable();
  // The budget starts with its burst and refills at FLOOR_CELLS_PER_MINUTE:
  // 40 flushes (40 s) may spend at most the burst plus 40 s of refill.
  const asked = crowd(t, app, floors, 40);
  const secondsElapsed = (40 * COLD_CELL_FLUSH_MS) / 1000;
  assert.ok(
    asked <=
      FLOOR_CELLS_BURST + (FLOOR_CELLS_PER_MINUTE * secondsElapsed) / 60 + 1,
    `in ${secondsElapsed} s ${asked}`,
  );
  assert.ok(asked > 0);
});

test('a minute after an idle spell spends no more than a minute of budget plus the burst', async (t) => {
  const floors = floorService();
  const app = harness(t, { at: CHICAGO, ground: floors.ground });
  await app.enable();
  // Idle long enough for any bucket to fill to the brim.
  t.mock.timers.tick(10 * 60_000);
  const asked = crowd(t, app, floors, 60);
  assert.ok(
    asked <= FLOOR_CELLS_PER_MINUTE + FLOOR_CELLS_BURST,
    `in a minute ${asked}`,
  );
  // About 24 of the 90 terrain requests a minute, not 38.
  assert.ok(Math.ceil(asked / 64) <= 24, `${Math.ceil(asked / 64)} requests`);
  // And the refill is spent: the crowd is not starved.
  assert.ok(asked >= FLOOR_CELLS_PER_MINUTE, `in a minute ${asked}`);
});

/** A trip through Boston, its terminus 120 km away (Portland, Maine). */
const STOPS = [
  { stopId: 'A', name: 'South Station', lat: 42.3523, lon: -71.0552 },
  { stopId: 'B', name: 'North Station', lat: 42.3656, lon: -71.0613 },
  { stopId: 'C', name: 'Woburn', lat: 42.5168, lon: -71.1442 },
  { stopId: 'D', name: 'Portland', lat: 43.6532, lon: -70.3122 },
].map((stop, i) => ({
  ...stop,
  state: i === 0 ? 'passed' : i === 1 ? 'next' : 'upcoming',
  relative: i === 0 ? 'T+3' : `T−${i * 10}`,
  expectedArrival: '14:32',
}));

const heightOf = (position) =>
  Cesium.Cartographic.fromCartesian(position).height;

test('stops placed before their cells were warm move up onto the floor', async (t) => {
  const floors = floorService();
  const app = harness(t, {
    at: BOSTON,
    altitude: LOW_M,
    ground: floors.ground,
    stops: { stopsFor: () => ({ stops: STOPS }) },
  });
  app.feeds.set('mbta-rail', () => [train('T1', BOSTON.lat, BOSTON.lon)]);
  await app.enable();
  const key = railTrainKey('mbta-rail', 'T1');
  app.parts().selection.selectTrain(key);
  const dots = app.primitives.find(
    (primitive) => primitive instanceof Cesium.PointPrimitiveCollection,
  );
  const dotHeights = () =>
    Array.from({ length: dots.length }, (_, i) =>
      heightOf(dots.get(i).position),
    );
  const labelHeights = () =>
    app.overlayEntries
      .get(RAIL_STOP_OVERLAY_SOURCE_ID)
      .map((entry) => heightOf(entry.position));
  assert.equal(dots.length, STOPS.length);
  // Every stop's cell is cold: on the ellipsoid for now.
  for (const h of [...dotHeights(), ...labelHeights()])
    assert.ok(Math.abs(h) < 0.01, `on the ellipsoid (${h})`);
  // Their cells are warmed, the terminus too though it is 120 km off.
  t.mock.timers.tick(COLD_CELL_FLUSH_MS);
  for (const stop of STOPS)
    assert.ok(floors.requested.includes(cellKey(stop)), stop.name);
  // Once warm, the next refresh stands them on the floor.
  for (const stop of STOPS) floors.warm.set(cellKey(stop), 20);
  t.mock.timers.tick(STOP_REFRESH_MS);
  assert.equal(dots.length, STOPS.length);
  for (const h of [...dotHeights(), ...labelHeights()])
    assert.ok(Math.abs(h - 21.5) < 0.01, `on the floor (${h})`);
  // Placed on a real floor, a stop is not read again.
  floors.warm.clear();
  t.mock.timers.tick(STOP_REFRESH_MS * 3);
  for (const h of dotHeights()) assert.ok(Math.abs(h - 21.5) < 0.01);
});
