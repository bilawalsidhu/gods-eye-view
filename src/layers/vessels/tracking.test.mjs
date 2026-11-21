import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { bindRenderer } from '../../render/rendererOf.js';
import { createTracking, nearestKnown, spread } from './tracking.js';
import {
  TRAIL_HEIGHT_M,
  TRAIL_MAX_POINTS,
  WATER_SURFACE_MAX_CAMERA_HEIGHT_M,
} from './policy.js';

/** One tracking part over a fake trail and geoid; `geoidN` is N everywhere.
 *  `ground`: a terrain cache (see `fakeGround`), or none. */
function setup({ geoidN = 40, track = null, clockAt = null, ground } = {}) {
  const drawn = [];
  const heads = [];
  const trail = {
    setPositions: (positions) => drawn.push([...positions]),
    setHead: (positions) => heads.push(positions),
    clear() {},
    destroy() {},
  };
  const synced = [];
  const records = [];
  const vesselState = {
    _geoidReady: true,
    _source: {
      getTrack: async (reference, options) =>
        typeof track === 'function' ? track(options) : track,
    },
    timeline: { active: () => clockAt !== null },
    worldNow: () => clockAt,
    state: {
      viewer: {},
      trail: null,
      trailPositions: [],
      trailBackfillToken: 0,
      trailAbort: null,
      trailId: null,
      records: { all: records },
    },
  };
  const visuals = new Map();
  const parts = {
    queries: {
      vesselDatumHeightM: (n, lift) => (Number.isFinite(n) ? n : 0) + lift,
    },
    rendering: {
      getVisual: (record) => visuals.get(record) ?? record,
      // Drawn where its visual says, at the trail's height in these tests.
      drawnPositionNow: (record) => {
        const visual = visuals.get(record);
        return visual
          ? Cesium.Cartesian3.fromDegrees(
              visual.drawnLon,
              visual.drawnLat,
              geoidN + TRAIL_HEIGHT_M,
            )
          : null;
      },
      anchorPosition: (record, liftM) =>
        liftM === undefined
          ? { anchoredAt: [record.lon, record.lat] }
          : { anchoredAt: [record.lon, record.lat], liftM },
      syncRecordIcon: (record) => synced.push(record),
      forgetClockStep: () => synced.push('forgetClockStep'),
    },
  };
  const renders = [];
  const tracking = createTracking({
    vesselState,
    services: {
      ...(ground ? { ground } : {}),
      geoid: { geoidHeight: () => geoidN },
      trails: { createTrail: () => trail },
      render: { governorRequestRender: (reason) => renders.push(reason) },
    },
    parts,
    layer: {},
    options: {},
  });
  return {
    tracking,
    vesselState,
    drawn,
    heads,
    synced,
    records,
    visuals,
    renders,
  };
}

const near = (a, b) =>
  Math.abs(a.x - b.x) < 1e-6 &&
  Math.abs(a.y - b.y) < 1e-6 &&
  Math.abs(a.z - b.z) < 1e-6;

/** A terrain cache over `terrainAt`, filled only when cells are resolved. */
function fakeGround(terrainAt) {
  const cache = new Map();
  const requested = [];
  return {
    FLOOR_CELL_DEG: 0.001,
    coarseFloorCoord: (lat, lon) => ({
      lat: Number(lat.toFixed(3)),
      lon: Number(lon.toFixed(3)),
    }),
    cachedRealEllipsoidalGround: (lat, lon) =>
      cache.get(`${lat},${lon}`) ?? null,
    async resolveEllipsoidalGround(cells, { signal } = {}) {
      requested.push(...cells.map((c) => `${c.lat},${c.lon}`));
      // Answered later, as a request is.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) return;
      for (const c of cells)
        cache.set(`${c.lat},${c.lon}`, terrainAt(c.lat, c.lon));
    },
    requested,
  };
}

async function settleBatches() {
  for (let i = 0; i < 10; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Point the tracking part's viewer camera at `lat`/`lon` from `height`. */
function lookFrom(vesselState, { lat, lon, height }) {
  return bindRenderer(vesselState.state.viewer, {
    camera: { pose: () => ({ lat, lon, height }) },
  });
}

// Lake Michigan: water 176 m above a −36.4 m geoid; east of −86.98, the sea
// (a stand-in shore, 4 km from the lake vessel, so both are in view).
const LAKE_N = -36.4;
const LAKE_LEVEL = 140.4;
const lakeTerrain = (lat, lon) =>
  lat > 43 && lat < 45 && lon > -88 && lon < -86.98 ? LAKE_LEVEL : LAKE_N;

test('vessels in view move onto their lake level when its terrain arrives', async () => {
  const ground = fakeGround(lakeTerrain);
  const { tracking, vesselState, records, visuals, synced, renders } = setup({
    geoidN: LAKE_N,
    ground,
  });
  const onLake = { lat: 44, lon: -87 };
  const atSea = { lat: 44, lon: -86.95 };
  const farAway = { lat: 10, lon: 10 };
  records.push(onLake, atSea, farAway);
  const waterlines = new Map();
  for (const record of records) {
    waterlines.set(record, { x: 0, y: 0, z: 0 });
    visuals.set(record, { waterline: waterlines.get(record) });
  }
  assert.equal(tracking.currentWaterSurfaceM(44, -87), LAKE_N, 'not known yet');
  const unbind = lookFrom(vesselState, { lat: 44, lon: -87, height: 5000 });
  try {
    tracking.warmWaterSurface();
    await settleBatches();
  } finally {
    unbind();
  }
  assert.ok(ground.requested.includes('44,-87'));
  assert.ok(ground.requested.includes('44,-86.95'));
  assert.ok(!ground.requested.includes('10,10'), 'only vessels in view');
  assert.equal(tracking.currentWaterSurfaceM(44, -87), LAKE_LEVEL);
  assert.equal(tracking.currentWaterSurfaceM(44, -86.95), LAKE_N, 'the sea');
  // Re-anchored: its icon, and its model's waterline written in place (the
  // model item holds that object).
  const visual = visuals.get(onLake);
  assert.deepEqual(visual.position, { anchoredAt: [-87, 44] });
  assert.equal(visual.waterline, waterlines.get(onLake));
  assert.ok(synced.includes(onLake));
  assert.ok(!synced.includes(farAway), 'vessels elsewhere stay as drawn');
  assert.ok(renders.includes('ais-vessels-refloor'));
});

test('a low camera reaches vessels well past its own height', async () => {
  const ground = fakeGround(lakeTerrain);
  const { tracking, vesselState, records } = setup({ geoidN: LAKE_N, ground });
  // 15 km south of the camera, which is 3 km up: on screen when tilted.
  records.push({ lat: 43.865, lon: -87 });
  const unbind = lookFrom(vesselState, { lat: 44, lon: -87, height: 3000 });
  try {
    tracking.warmWaterSurface();
    await settleBatches();
  } finally {
    unbind();
  }
  assert.equal(tracking.currentWaterSurfaceM(43.865, -87), LAKE_LEVEL);
});

test('on a flat globe vessels are drawn at height 0, and back on the sea once terrain loads', async () => {
  // The terrain service is down: the shown globe is the bare ellipsoid,
  // whose sea is at 0 m, while the geoid off Rotterdam is +45 m.
  let surface = { version: 1, source: 'ellipsoid' };
  const listeners = [];
  const ground = fakeGround(() => 45);
  const { tracking, vesselState, records, visuals, renders } = setup({
    geoidN: 45,
    ground,
  });
  const vessel = { lat: 51.95, lon: 4.0 };
  records.push(vessel);
  visuals.set(vessel, { waterline: {} });
  const unbind = bindRenderer(vesselState.state.viewer, {
    camera: { pose: () => ({ lat: 51.95, lon: 4.0, height: 5000 }) },
    globe: {
      isGlobeVisible: () => true,
      surfaceVersion: () => surface.version,
      on: (event, listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    },
    query: {
      sampleHeight: async (points) =>
        points.map(() => ({
          height: surface.source === 'ellipsoid' ? 0 : 45,
          source: surface.source,
        })),
    },
  });
  try {
    tracking.watchSurface(vesselState.state.viewer);
    await settleBatches();
    assert.equal(tracking.currentWaterSurfaceM(51.95, 4.0), 0);
    assert.ok(renders.includes('ais-vessels-refloor'), 'moved down at once');
    // A flat globe has no terrain worth asking for.
    tracking.warmWaterSurface();
    await settleBatches();
    assert.deepEqual(ground.requested, []);
    // The terrain loads: a new surface, asked about as the globe reports.
    surface = { version: 2, source: 'terrain' };
    for (const listener of [...listeners]) listener({});
    await settleBatches();
    assert.equal(tracking.currentWaterSurfaceM(51.95, 4.0), 45);
    assert.ok(
      ground.requested.includes('51.95,4'),
      'asked for at once, not at the next poll',
    );
    tracking.unwatchSurface();
    assert.equal(listeners.length, 0, 'stops following the globe when off');
  } finally {
    unbind();
  }
});

test('a hidden globe (the photoreal stack) is never taken as flat', async () => {
  const { tracking, vesselState } = setup({ geoidN: 45 });
  let asked = 0;
  const unbind = bindRenderer(vesselState.state.viewer, {
    camera: { pose: () => ({ lat: 51.95, lon: 4.0, height: 5000 }) },
    globe: { isGlobeVisible: () => false, surfaceVersion: () => 1 },
    query: {
      sampleHeight: async (points) => {
        asked += 1;
        return points.map(() => ({ height: 0, source: 'ellipsoid' }));
      },
    },
  });
  try {
    tracking.watchSurface(vesselState.state.viewer);
    await settleBatches();
  } finally {
    unbind();
  }
  assert.equal(asked, 0);
  assert.equal(tracking.currentWaterSurfaceM(51.95, 4.0), 45);
});

test('a moving vessel keeps its lake level over cells not fetched yet', async () => {
  const ground = fakeGround(lakeTerrain);
  const { tracking, vesselState, records } = setup({ geoidN: LAKE_N, ground });
  const vessel = { lat: 44, lon: -87 };
  records.push(vessel);
  const unbind = lookFrom(vesselState, { lat: 44, lon: -87, height: 5000 });
  try {
    tracking.warmWaterSurface();
    await settleBatches();
  } finally {
    unbind();
  }
  assert.equal(tracking.currentWaterSurfaceM(44, -87, vessel), LAKE_LEVEL);
  // Drawn on along its track, into a cell nobody has fetched.
  assert.equal(tracking.currentWaterSurfaceM(44.02, -87, vessel), LAKE_LEVEL);
  assert.equal(
    tracking.currentWaterSurfaceM(44.02, -87),
    LAKE_N,
    'no vessel to go by: the geoid',
  );
  // Far from where it was read (a clock jump): the geoid until read again.
  assert.equal(tracking.currentWaterSurfaceM(44.1, -87, vessel), LAKE_N);
});

test('the water ahead of a moving vessel is asked for too', async () => {
  const ground = fakeGround(lakeTerrain);
  const { tracking, vesselState, records } = setup({ geoidN: LAKE_N, ground });
  // 12 kn due north: about 740 m on in two minutes.
  records.push({ lat: 44, lon: -87, speed: 12, course: 0 });
  const unbind = lookFrom(vesselState, { lat: 44, lon: -87, height: 5000 });
  try {
    tracking.warmWaterSurface();
    await settleBatches();
  } finally {
    unbind();
  }
  assert.ok(ground.requested.includes('44.007,-87'));
  assert.equal(tracking.currentWaterSurfaceM(44.007, -87), LAKE_LEVEL);
});

test('turning the layer off cancels the water levels on their way', async () => {
  const ground = fakeGround(lakeTerrain);
  const { tracking, vesselState, records, visuals, synced } = setup({
    geoidN: LAKE_N,
    ground,
  });
  const vessel = { lat: 44, lon: -87 };
  records.push(vessel);
  visuals.set(vessel, { waterline: {} });
  const unbind = lookFrom(vesselState, { lat: 44, lon: -87, height: 5000 });
  try {
    tracking.warmWaterSurface();
    // Off before the terrain answers.
    tracking.unwatchSurface();
    await settleBatches();
  } finally {
    unbind();
  }
  assert.equal(ground.requested.length, 1, 'nothing after the first batch');
  assert.deepEqual(synced, [], 'nothing moved');
  assert.equal(tracking.currentWaterSurfaceM(44, -87, vessel), LAKE_N);
});

test('a tilted camera high up reaches the vessels it shows far off', async () => {
  const ground = fakeGround(lakeTerrain);
  const { tracking, vesselState, records } = setup({ geoidN: LAKE_N, ground });
  // 45 km from a camera 12 km up: past the 30 km floor, within 4 × height.
  records.push({ lat: 44.405, lon: -87 });
  const unbind = lookFrom(vesselState, { lat: 44, lon: -87, height: 12000 });
  try {
    tracking.warmWaterSurface();
    await settleBatches();
  } finally {
    unbind();
  }
  assert.ok(ground.requested.includes('44.405,-87'));
});

test('a high camera asks the terrain for nothing', async () => {
  const ground = fakeGround(lakeTerrain);
  const { tracking, vesselState, records } = setup({ geoidN: LAKE_N, ground });
  records.push({ lat: 44, lon: -87 });
  const unbind = lookFrom(vesselState, {
    lat: 44,
    lon: -87,
    height: WATER_SURFACE_MAX_CAMERA_HEIGHT_M + 1,
  });
  try {
    tracking.warmWaterSurface();
    await settleBatches();
  } finally {
    unbind();
  }
  assert.deepEqual(ground.requested, []);
});

test('a lake trail keeps to the lake while its samples are fetched', async () => {
  // The track's cells sit 0.6 m higher than the vessel's, so the lift shows.
  const ground = fakeGround((lat, lon) =>
    lat < 43.99 ? LAKE_LEVEL + 0.6 : lakeTerrain(lat, lon),
  );
  const track = { records: [{ latitude: 43.9, longitude: -87 }] };
  const { tracking, vesselState, records } = setup({
    geoidN: LAKE_N,
    ground,
    track,
  });
  const vessel = { id: '1', mmsi: '1', reference: '1', lat: 44, lon: -87 };
  records.push(vessel);
  const unbind = lookFrom(vesselState, { lat: 44, lon: -87, height: 5000 });
  try {
    tracking.warmWaterSurface();
    await settleBatches();
  } finally {
    unbind();
  }
  vesselState.state.selectedRecord = vessel;
  tracking.startSelectedVesselTrail(vessel);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lifted = (lat, level) =>
    Cesium.Cartesian3.fromDegrees(-87, lat, level + TRAIL_HEIGHT_M);
  // Backfilled before its own cell is known: on the vessel's lake level,
  // not the geoid 177 m under the water.
  assert.ok(
    near(vesselState.state.trailPositions[0], lifted(43.9, LAKE_LEVEL)),
  );
  assert.ok(near(vesselState.state.trailPositions[1], lifted(44, LAKE_LEVEL)));
  await settleBatches();
  // Then on its own cell's level.
  assert.ok(
    near(vesselState.state.trailPositions[0], lifted(43.9, LAKE_LEVEL + 0.6)),
  );
  assert.ok(near(vesselState.state.trailPositions[1], lifted(44, LAKE_LEVEL)));
});

test('trail vertices sit TRAIL_HEIGHT_M above the geoid, as Cesium places them', () => {
  const { tracking } = setup({ geoidN: 40 });
  const position = tracking.vesselTrailPosition({ lat: 51.9, lon: 4.05 });
  const expected = Cesium.Cartesian3.fromDegrees(
    4.05,
    51.9,
    40 + TRAIL_HEIGHT_M,
  );
  assert.ok(near(position, expected));
  assert.equal(tracking.vesselTrailPosition({ lat: NaN, lon: 4 }), null);
});

test('a selected trail backfills older samples ahead of the live fix', async () => {
  const track = {
    records: [
      { latitude: 51.8, longitude: 4.0 },
      { latitude: 'x', longitude: 4.0 },
      { latitude: 51.85, longitude: 4.02 },
    ],
  };
  const { tracking, vesselState, drawn } = setup({ track });
  tracking.startSelectedVesselTrail({
    mmsi: '1',
    reference: '1',
    lat: 51.9,
    lon: 4.05,
  });
  assert.equal(drawn.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const positions = vesselState.state.trailPositions;
  assert.equal(positions.length, 3);
  assert.ok(
    near(
      positions[0],
      Cesium.Cartesian3.fromDegrees(4.0, 51.8, 40 + TRAIL_HEIGHT_M),
    ),
    'oldest first',
  );
  assert.ok(
    near(
      positions[1],
      Cesium.Cartesian3.fromDegrees(4.02, 51.85, 40 + TRAIL_HEIGHT_M),
    ),
  );
  assert.ok(
    near(
      positions[2],
      Cesium.Cartesian3.fromDegrees(4.05, 51.9, 40 + TRAIL_HEIGHT_M),
    ),
  );
  assert.deepEqual(drawn.at(-1), positions);
});

test('a refreshed fix joins the trail only once it has moved far enough', () => {
  const { tracking, vesselState, drawn } = setup();
  const record = { mmsi: '1', reference: '1', lat: 51.9, lon: 4.05 };
  tracking.startSelectedVesselTrail(record);
  const before = drawn.length;
  // About 11 m north: under TRAIL_MIN_MOVE_M.
  tracking.appendSelectedVesselTrailFix({ ...record, lat: 51.9001 });
  assert.equal(vesselState.state.trailPositions.length, 1);
  assert.equal(drawn.length, before);
  // About 111 m north.
  tracking.appendSelectedVesselTrailFix({ ...record, lat: 51.901 });
  assert.equal(vesselState.state.trailPositions.length, 2);
  assert.equal(drawn.length, before + 1);
});

test('refloor re-anchors every fixed record through the rendering part', () => {
  const { tracking, records, visuals, synced, renders } = setup();
  const fixed = { lat: 51.9, lon: 4.05 };
  const unfixed = { lat: NaN, lon: 4.05 };
  records.push(fixed, unfixed);
  const visual = {};
  visuals.set(fixed, visual);
  tracking.refloorVesselRecords();
  assert.deepEqual(visual.position, { anchoredAt: [4.05, 51.9] });
  // Drawn somewhere else, the vessels move on the next clock pass however
  // little they would.
  assert.deepEqual(synced, [fixed, 'forgetClockStep']);
  assert.deepEqual(renders, ['ais-vessels-refloor']);
});

test('a long backfill keeps the newest TRAIL_MAX_POINTS vertices', async () => {
  const records = [];
  for (let i = 0; i < TRAIL_MAX_POINTS + 50; i += 1)
    records.push({ latitude: 50 + i * 0.001, longitude: 4 });
  const { tracking, vesselState } = setup({ track: { records } });
  tracking.startSelectedVesselTrail({
    mmsi: '1',
    reference: '1',
    lat: 51.9,
    lon: 4.05,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const positions = vesselState.state.trailPositions;
  assert.equal(positions.length, TRAIL_MAX_POINTS);
  // The oldest 51 (50 backfilled samples and room for the live fix) are gone.
  const firstKept = 50 + 51 * 0.001;
  assert.ok(
    near(
      positions[0],
      Cesium.Cartesian3.fromDegrees(4, firstKept, 40 + TRAIL_HEIGHT_M),
    ),
  );
  assert.ok(
    near(
      positions.at(-1),
      Cesium.Cartesian3.fromDegrees(4.05, 51.9, 40 + TRAIL_HEIGHT_M),
    ),
    'the live fix stays newest',
  );
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const at = (lat, lon) =>
  Cesium.Cartesian3.fromDegrees(lon, lat, 40 + TRAIL_HEIGHT_M);

test('following the clock, the trail ends at the vessel: fixes after its time wait, and a head joins the last one to it', async () => {
  const T = 1_800_000_000_000;
  const track = {
    records: [
      { latitude: 51.8, longitude: 4.0, observedAtMs: T - 120_000 },
      { latitude: 51.81, longitude: 4.0, observedAtMs: T - 60_000 },
    ],
  };
  const { tracking, vesselState, drawn, heads, visuals } = setup({
    track,
    clockAt: T,
  });
  const record = {
    id: 'v',
    reference: 'v',
    lat: 51.83,
    lon: 4.0,
    lastPositionEpoch: (T + 120_000) / 1000,
  };
  vesselState.state.selectedRecord = record;
  visuals.set(record, { drawnLat: 51.815, drawnLon: 4.0, drawnAtMs: T });
  tracking.startSelectedVesselTrail(record);
  await settle();
  assert.equal(drawn.at(-1).length, 2, 'the fixes before the time');
  assert.ok(near(drawn.at(-1)[1], at(51.81, 4.0)));
  tracking.drawSelectedVesselTrail();
  const head = heads.at(-1);
  assert.ok(near(head[0], at(51.81, 4.0)), 'from the last drawn fix');
  assert.ok(near(head[1], at(51.815, 4.0)), 'to the vessel as drawn');

  // The clock passes the vessel's own fix: the body takes it on the next
  // frame, and the vessel holds there.
  vesselState.worldNow = () => T + 150_000;
  visuals.get(record).drawnLat = 51.83;
  tracking.drawSelectedVesselTrail();
  assert.equal(drawn.at(-1).length, 3);
  assert.equal(heads.at(-1), null, 'no head with the vessel on its fix');
});

test('a clock jump keeps the trail drawn to the new time until the track at it arrives', async () => {
  const T = 1_800_000_000_000;
  let release;
  const later = new Promise((resolve) => (release = resolve));
  let asked = 0;
  const first = {
    records: [
      { latitude: 51.8, longitude: 4.0, observedAtMs: T - 120_000 },
      { latitude: 51.81, longitude: 4.0, observedAtMs: T - 60_000 },
    ],
  };
  const { tracking, vesselState, drawn, visuals } = setup({
    track: () => (asked++ === 0 ? first : later),
    clockAt: T,
  });
  const record = {
    id: 'v',
    reference: 'v',
    lat: 51.815,
    lon: 4.0,
    lastPositionEpoch: T / 1000,
  };
  vesselState.state.selectedRecord = record;
  visuals.set(record, { drawnLat: 51.815, drawnLon: 4.0, drawnAtMs: T });
  tracking.startSelectedVesselTrail(record);
  await settle();
  const before = drawn.length;
  // Back a minute and a half: one fix is behind the vessel then.
  vesselState.worldNow = () => T - 90_000;
  tracking.retimeSelectedVesselTrail(record);
  assert.ok(
    drawn.slice(before).every((positions) => positions.length >= 1),
    'never blanked',
  );
  assert.equal(drawn.at(-1).length, 1, 'cut to the new time');
  release({
    records: [
      { latitude: 51.79, longitude: 4.0, observedAtMs: T - 180_000 },
      { latitude: 51.8, longitude: 4.0, observedAtMs: T - 120_000 },
    ],
  });
  await settle();
  assert.equal(drawn.at(-1).length, 2, 'the track at the new time');
  assert.ok(near(drawn.at(-1)[0], at(51.79, 4.0)));
});

test('live, the head joins the last fix to the vessel where it is placed, and not across a jump', () => {
  const { tracking, vesselState, heads, visuals } = setup();
  const record = { id: 'v', reference: 'v', lat: 51.8, lon: 4.0 };
  vesselState.state.selectedRecord = record;
  visuals.set(record, { drawnLat: 51.801, drawnLon: 4.0 });
  tracking.startSelectedVesselTrail(record);
  tracking.drawSelectedVesselTrail();
  assert.ok(near(heads.at(-1)[0], at(51.8, 4.0)));
  assert.ok(near(heads.at(-1)[1], at(51.801, 4.0)));
  // Drawn 100 km on: no head across that.
  visuals.get(record).drawnLat = 52.7;
  tracking.drawSelectedVesselTrail();
  assert.equal(heads.at(-1), null);
});

test('an unknown entry takes the nearest known one along the list', () => {
  const u = undefined;
  assert.deepEqual(nearestKnown([u, 1, u, u, u, null, u]), [
    1,
    1,
    1,
    1,
    null,
    null,
    null,
  ]);
  assert.deepEqual(nearestKnown([u, u]), [u, u]);
  assert.deepEqual(spread([1, 2, 3, 4, 5], 3), [1, 3, 5]);
  assert.deepEqual(spread([1, 2], 5), [1, 2]);
});

test('a trail from the sea up a river keeps the sea at sea and the river on it', async () => {
  // North of 44.05 the river at 140.4 m; south of it the sea.
  const ground = fakeGround((lat, lon) => (lat > 44.05 ? LAKE_LEVEL : LAKE_N));
  const samples = [];
  for (let i = 0; i < 300; i += 1)
    samples.push({ latitude: 43.9 + i * 0.001, longitude: -87 });
  const { tracking, vesselState, records } = setup({
    geoidN: LAKE_N,
    ground,
    track: { records: samples },
  });
  const vessel = { id: '1', mmsi: '1', reference: '1', lat: 44.2, lon: -87 };
  records.push(vessel);
  const unbind = lookFrom(vesselState, { lat: 44.2, lon: -87, height: 5000 });
  try {
    tracking.warmWaterSurface();
    await settleBatches();
    vesselState.state.selectedRecord = vessel;
    tracking.startSelectedVesselTrail(vessel);
    await settleBatches();
  } finally {
    unbind();
  }
  const heightAt = (lat) => {
    const i = Math.round((lat - 43.9) / 0.001);
    return Cesium.Cartographic.fromCartesian(
      vesselState.state.trailPositions[i],
    ).height;
  };
  // Every vertex either on the sea or on the river, by where it is.
  assert.ok(Math.abs(heightAt(43.95) - (LAKE_N + TRAIL_HEIGHT_M)) < 0.01);
  assert.ok(Math.abs(heightAt(44.15) - (LAKE_LEVEL + TRAIL_HEIGHT_M)) < 0.01);
});
