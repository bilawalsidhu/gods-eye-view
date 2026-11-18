import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializePlayback,
  recordFix,
  updatePlayback,
  displayMotion,
  applyDisplayCourse,
  displacementPlausible,
} from './movement.js';
import { buildTransitSelectionCopy } from './policy.js';
import { sampleAt } from '../../data/contactPlayback.js';
import { layerPlacement } from '../../data/placementProvider.js';
const entry = () => {
  const e = { mode: 'bus', modeInferred: false, courseDeg: null };
  initializePlayback(e);
  return e;
};
const fix = (t, lat = 42) => ({ t, lat, lon: -71 });
test('transit mode admission retains the permissive ceiling for inferred modes', () => {
  assert.equal(displacementPlausible('bus', 583, 15), false);
  assert.equal(displacementPlausible('bus', 583, 15, true), true);
  assert.equal(displacementPlausible('rail', 583, 15), true);
});
test('a lone implausible fix cannot teleport; two coherent replacement fixes break the path', () => {
  const e = entry();
  recordFix(e, fix(0));
  recordFix(e, fix(15000, 42.001));
  assert.equal(recordFix(e, fix(30000, 43)).accepted, false);
  assert.equal(e.track.count, 2);
  assert.equal(recordFix(e, fix(45000, 43.001)).accepted, true);
  assert.equal(e.track.count, 4);
  assert.equal(sampleAt(e.track, 22500, {}).segmentSpeedMps, 0);
});
test('clock correction requires three distinct advancing observations, never three cached packets', () => {
  const e = entry();
  recordFix(e, fix(100000));
  for (let i = 0; i < 10; i++) recordFix(e, fix(10000));
  assert.equal(e.track.resets, 0);
  recordFix(e, fix(20000));
  recordFix(e, fix(30000));
  assert.equal(e.track.resets, 1);
  assert.equal(e.track.count, 2);
});
test('orientation alone smooths at 120 degrees/s and waiting/stale override moving copy', () => {
  const e = entry();
  recordFix(e, { ...fix(0), bearingDeg: 90 });
  recordFix(e, { ...fix(15000, 42.00005), bearingDeg: 270 });
  updatePlayback(e, 30000, 0);
  e.courseDeg = 0;
  e.courseEvalAt = 0;
  applyDisplayCourse(e, 100);
  assert.equal(e.courseDeg, 12);
  applyDisplayCourse(e, 100);
  assert.equal(e.courseDeg, 12);
  updatePlayback(e, 45000, 15000);
  assert.equal(displayMotion(e, 45000).word, 'WAITING');
  updatePlayback(e, 200000, 170000);
  assert.equal(displayMotion(e, 200000).word, 'NO FIX');
});

test('display copy never borrows a future bearing and follows anchored freshness after a wall jump', () => {
  const e = entry();
  recordFix(e, fix(10000));
  recordFix(e, { ...fix(25000, 42.000005), bearingDeg: 270 });
  updatePlayback(e, 35000, 0);
  assert.equal(e.sample.displayT, 10000);
  assert.ok(!Number.isFinite(e.sample.segmentCourseDeg));
  const record = { id: 'test', timestamp: 25, bearing: 270 };
  const copy = (wall) =>
    buildTransitSelectionCopy(
      { name: 'Test', region: 'Test' },
      record,
      'bus',
      wall,
      null,
      e,
    );
  const before = copy(35000);
  assert.equal(before.details[1], 'Moving');
  assert.ok(before.details.includes('reported hdg 270°'));
  assert.ok(!before.details[1].includes('270'));
  updatePlayback(e, 3600000, 16);
  assert.equal(e.sample.motion, 'moving');
  assert.equal(e.sample.latestReportAgeMs, 10016);
  assert.equal(displayMotion(e, 3600000).word, 'EN ROUTE');
  assert.equal(copy(3600000).details[2], before.details[2]);
  assert.match(
    copy(3600000).details[2],
    /Reported 10 s ago · shown 25 s behind/,
  );
});

test('mesh-floor sampling owns fully initialized numeric scratch before the first frame', async () => {
  const { correctHeight } = await import('../../data/contactPlayback.js');
  const e = entry();
  const scratch = [
    e.track.from,
    e.track.to,
    e.track.latest,
    e.track.metricsScratchA,
    e.track.metricsScratchB,
    e.segment.from,
    e.segment.to,
  ];
  const fields = [
    't',
    'lat',
    'lon',
    'heightM',
    'h',
    'receivedAt',
    'bearingDeg',
    'flags',
    'epoch',
    'seq',
  ];
  for (const value of scratch)
    for (const field of fields)
      assert.equal(
        typeof value[field],
        'number',
        `preallocated numeric ${field}`,
      );
  const shapes = scratch.map((value) => Object.keys(value));
  recordFix(e, fix(10000));
  recordFix(e, fix(25000, 42.001));
  correctHeight(e.track, e.track.baseSeq, 12.125);
  correctHeight(e.track, e.track.baseSeq + 1, 37.375);
  for (let i = 0; i < 10000; i++) {
    assert.equal(updatePlayback(e, 35000 + i, i), e.sample);
    assert.equal(sampleAt(e.track, 10000 + i, e.sample), e.sample);
    assert.ok(Number.isFinite(e.sample.heightM));
  }
  [
    e.track.from,
    e.track.to,
    e.track.latest,
    e.track.metricsScratchA,
    e.track.metricsScratchB,
    e.segment.from,
    e.segment.to,
  ].forEach((value, i) => assert.equal(value, scratch[i]));
  scratch.forEach((value, i) =>
    assert.deepEqual(Object.keys(value), shapes[i]),
  );
});

test('course fallback prefers held course, then finite reported bearing, then unknown', () => {
  for (const [held, bearing, expected] of [
    [90, 270, 90],
    [null, 90, 90],
    [NaN, 0, 0],
    [null, null, null],
    [null, NaN, null],
    [null, Infinity, null],
  ]) {
    const e = {
      courseDeg: held,
      sample: { segmentCourseDeg: NaN },
      record: { bearing },
    };
    applyDisplayCourse(e, 100);
    assert.equal(e.courseDeg, expected);
  }
});

const placedEntry = (placement) => {
  const e = {
    key: 'feed:7',
    feedId: 'feed',
    mode: 'bus',
    modeInferred: false,
    courseDeg: null,
    placement,
  };
  initializePlayback(e);
  return e;
};
const drive = (e) => {
  recordFix(e, { ...fix(0), bearingDeg: 10 });
  recordFix(e, { ...fix(15000, 42.001), bearingDeg: 20 });
  recordFix(e, fix(30000, 42.002));
  const samples = [];
  for (let wall = 0; wall <= 120000; wall += 2500) {
    updatePlayback(e, wall, wall);
    samples.push({ ...e.sample });
  }
  return samples;
};
test('without a placement, or one that places nothing, playback is the layer own', () => {
  const own = drive(placedEntry(null));
  const declined = [];
  const placement = layerPlacement(
    {
      layer: () => ({
        observe: (id, f) => declined.push([id, f.timeMs]),
        place: () => null,
      }),
    },
    'transit',
  );
  const e = placedEntry(placement);
  assert.deepEqual(drive(e), own);
  assert.equal(e.placed, false);
  assert.deepEqual(declined, [
    ['feed:7', 0],
    ['feed:7', 15000],
    ['feed:7', 30000],
  ]);
});
test('a placement draws the vehicle where it places it, keeping the playback state', () => {
  const own = drive(placedEntry(null));
  const e = placedEntry(
    layerPlacement(
      {
        layer: () => ({
          place: (id, wallMs) =>
            wallMs >= 60000
              ? { lat: 1, lon: 2, courseDeg: 45, speedMps: 7 }
              : { lat: 3, lon: 4 },
        }),
      },
      'transit',
    ),
  );
  const placed = drive(e);
  assert.equal(e.placed, true);
  for (let i = 0; i < own.length; i++) {
    const late = i * 2500 >= 60000;
    assert.equal(placed[i].lat, late ? 1 : 3);
    assert.equal(placed[i].lon, late ? 2 : 4);
    assert.equal(placed[i].phase, own[i].phase);
    assert.equal(placed[i].motion, own[i].motion);
    if (late) {
      assert.equal(placed[i].segmentCourseDeg, 45);
      assert.equal(placed[i].segmentSpeedMps, 7);
    } else {
      // No course or speed placed: the playback's own stand.
      assert.deepEqual(
        [placed[i].segmentCourseDeg, placed[i].segmentSpeedMps],
        [own[i].segmentCourseDeg, own[i].segmentSpeedMps],
      );
    }
  }
});
test('a refused fix is never told to the placement', () => {
  const told = [];
  const e = placedEntry(
    layerPlacement(
      {
        layer: () => ({
          observe: (id, f) => told.push(f.lat),
          place: () => null,
        }),
      },
      'transit',
    ),
  );
  recordFix(e, fix(0));
  recordFix(e, fix(15000, 42.001));
  assert.equal(recordFix(e, fix(30000, 43)).accepted, false);
  assert.deepEqual(told, [42, 42.001]);
});
