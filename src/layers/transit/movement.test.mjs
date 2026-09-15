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
import { seek, sampleAt } from '../../data/contactPlayback.js';
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
