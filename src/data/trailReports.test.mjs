import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  insertTrailFix,
  recordTrailPoint,
  trailBodySegments,
  trailPairBreaks,
  trailDistanceM,
  trailRecordingBlocked,
} from './trailContinuity.js';

// Reports decide where the line may run: recorded points never join two
// reports too far apart to be one flight, a report the display has already
// passed replaces the guess drawn after it, and old entries let go of the
// positions they stood for.

const SEC = 1000;
const LIMIT = 2_000;
const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
  Cesium.Cartesian3.fromDegrees(-100, 40, 0),
);
const at = (e, n, u = 10) =>
  Cesium.Matrix4.multiplyByPoint(
    enu,
    new Cesium.Cartesian3(e, n, u),
    new Cesium.Cartesian3(),
  );

/** No two neighbours in one drawn segment are too far apart to be one flight. */
function assertNoBrokenJoin(fixes) {
  const reports = fixes.filter((fix) => !fix.drawn && fix.position);
  for (const segment of trailBodySegments(fixes, fixes.length)) {
    const inSegment = reports.filter((r) =>
      segment.some((p) => Cesium.Cartesian3.distance(p, r.position) < 0.01),
    );
    for (let i = 1; i < inSegment.length; i++)
      assert.equal(
        trailPairBreaks(
          inSegment[i].timeMs - inSegment[i - 1].timeMs,
          trailDistanceM(inSegment[i - 1].position, inSegment[i].position),
        ),
        false,
        `one segment joins reports at ${inSegment[i - 1].timeMs / SEC} s and ${
          inSegment[i].timeMs / SEC
        } s`,
      );
  }
}

test('two reports 60 s and 51 km apart are not joined, even by recorded points', () => {
  const A = Cesium.Cartesian3.fromDegrees(-100, 40, 9_000);
  const B = Cesium.Cartesian3.fromDegrees(-99.4, 40, 9_000);
  const fixes = [];
  insertTrailFix(fixes, A, 0, LIMIT);
  insertTrailFix(fixes, B, 60 * SEC, LIMIT); // ahead of the display
  for (let t = 1; t < 60; t++) {
    // Nothing is recorded across the pair.
    assert.equal(trailRecordingBlocked(fixes, t * SEC), true);
  }
  assert.equal(trailBodySegments(fixes, fixes.length).length, 2);
  // Points recorded before the far report was known are dropped.
  const late = [];
  insertTrailFix(late, A, 0, LIMIT);
  for (let t = 1; t < 60; t++)
    recordTrailPoint(
      late,
      Cesium.Cartesian3.lerp(A, B, t / 60, new Cesium.Cartesian3()),
      t * SEC,
      LIMIT,
    );
  insertTrailFix(late, B, 60 * SEC, LIMIT);
  assert.equal(late.filter((fix) => fix.drawn).length, 0);
  assert.equal(trailBodySegments(late, late.length).length, 2);
  assertNoBrokenJoin(late);
});

test('a coast, a hold and then a far report: nothing is drawn across', () => {
  const A = at(0, 0, 9_000);
  const fixes = [];
  insertTrailFix(fixes, A, 0, LIMIT);
  // The icon coasts east for 90 s at 230 m/s, then holds.
  for (let t = 1; t <= 200; t++)
    recordTrailPoint(
      fixes,
      at(230 * Math.min(t, 90), 0, 9_000),
      t * SEC,
      LIMIT,
    );
  assert.ok(fixes.filter((fix) => fix.drawn).length > 0);
  // The next report is 150 km away two minutes later: over 1,500 kt.
  const B = at(0, 150_000, 9_000);
  insertTrailFix(fixes, B, 120 * SEC, LIMIT);
  assertNoBrokenJoin(fixes);
  const segments = trailBodySegments(fixes, fixes.length);
  const segmentOf = (p) =>
    segments.findIndex((s) =>
      s.some((q) => Cesium.Cartesian3.distance(p, q) < 0.01),
    );
  assert.notEqual(segmentOf(A), segmentOf(B));
  // No recorded point between the two reports remains.
  assert.equal(
    fixes.filter((fix) => fix.drawn && fix.timeMs < 120 * SEC).length,
    0,
  );
});

for (const off of [200, 400, 600, 1_000]) {
  test(`a report the display already passed, ${off} m off a 2 km turn, leaves no spike`, () => {
    const R = 2_000;
    const w = 100 / R;
    const pos = (t, r = R) =>
      at(r * Math.sin(w * t), R - r * Math.cos(w * t), 3_000);
    const fixes = [];
    insertTrailFix(fixes, pos(0), 0, LIMIT);
    for (let t = 1; t <= 60; t++)
      recordTrailPoint(fixes, pos(t), t * SEC, LIMIT);
    const report = pos(50, R - off);
    // It arrives with the display at 60 s; the ease takes 900 ms.
    insertTrailFix(fixes, report, 50 * SEC, LIMIT, {
      displayMs: 60 * SEC,
      settleMs: 900,
    });
    // The guess drawn after the report is gone...
    assert.deepEqual(
      fixes.filter((fix) => fix.drawn && fix.timeMs > 50 * SEC),
      [],
    );
    // ...nothing is recorded while the icon eases onto the correction...
    assert.equal(trailRecordingBlocked(fixes, 60.5 * SEC), true);
    assert.equal(trailRecordingBlocked(fixes, 61 * SEC), false);
    // ...and the line reads arc, report, corrected path.
    for (let t = 61; t <= 70; t++)
      recordTrailPoint(fixes, pos(t, R - off), t * SEC, LIMIT);
    const line = trailBodySegments(fixes, fixes.length).flat();
    const r = line.findIndex(
      (p) => Cesium.Cartesian3.distance(p, report) < 0.01,
    );
    assert.ok(r > 0);
    for (const p of line.slice(0, r))
      assert.ok(
        Math.abs(Cesium.Cartesian3.distance(p, at(0, R, 3_000)) - R) < 31,
        'a point before the report is off the arc',
      );
    for (const p of line.slice(r + 1))
      assert.ok(
        Math.abs(Cesium.Cartesian3.distance(p, at(0, R, 3_000)) - (R - off)) <
          31,
        'a point after the report is off the corrected path',
      );
  });
}

test('entries behind the report before the display let go of the positions they stood for', () => {
  const fixes = [];
  for (let s = 0; s <= 2 * 3_600; s++) {
    const p = at(230 * s, 0, 10_000);
    if (s % 15 === 0) insertTrailFix(fixes, p, s * SEC, LIMIT);
    else recordTrailPoint(fixes, p, s * SEC, LIMIT);
  }
  let held = 0;
  for (const fix of fixes) held += fix.absorbed?.length ?? 0;
  // Only the newest stretch, up to two reports back, keeps what it stood for.
  assert.ok(held <= 30, `${held} positions still held`);
});
