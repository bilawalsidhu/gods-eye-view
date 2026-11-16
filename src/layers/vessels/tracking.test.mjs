import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createTracking } from './tracking.js';
import { TRAIL_HEIGHT_M, TRAIL_MAX_POINTS } from './policy.js';

/** One tracking part over a fake trail and geoid; `geoidN` is N everywhere. */
function setup({ geoidN = 40, track = null } = {}) {
  const drawn = [];
  const trail = {
    setPositions: (positions) => drawn.push([...positions]),
    clear() {},
    destroy() {},
  };
  const synced = [];
  const records = [];
  const vesselState = {
    _geoidReady: true,
    _source: { getTrack: async () => track },
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
  return { tracking, vesselState, drawn, synced, records, visuals, renders };
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
