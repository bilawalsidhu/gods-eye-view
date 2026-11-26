import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createTracking } from './tracking.js';
import { TRAIL_HEIGHT_M, TRAIL_MAX_POINTS } from './policy.js';

/** One tracking part over a fake trail and geoid; `geoidN` is N everywhere. */
function setup({ geoidN = 40, track = null, clockAt = null } = {}) {
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
      anchorPosition: (record) => ({ anchoredAt: [record.lon, record.lat] }),
      syncRecordIcon: (record) => synced.push(record),
      forgetClockStep: () => synced.push('forgetClockStep'),
    },
  };
  const renders = [];
  const tracking = createTracking({
    vesselState,
    services: {
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
