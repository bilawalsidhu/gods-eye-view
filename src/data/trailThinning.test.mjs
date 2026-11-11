import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  insertTrailFix,
  joinTrailBackfill,
  recordTrailPoint,
  TRAIL_THIN_MAX_SPAN_M,
  TRAIL_THIN_TOLERANCE_M,
} from './trailContinuity.js';

// Recorded points are thinned by shape: a point stays only where the line
// would move without it. Reports always stay.

const SEC = 1000;
const LIMIT = 2_000;
const LAT0 = 40;
const LON0 = -100;
const M_PER_DEG_LAT = 111_320;
const mPerDegLon = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/** Straight and level east at `speed` m/s, `tSec` after the start. */
const eastbound = (speed, tSec, heightM = 10_000) =>
  Cesium.Cartesian3.fromDegrees(
    LON0 + (speed * tSec) / mPerDegLon(LAT0),
    LAT0,
    heightM,
  );

/** A standard-rate (3°/s) left turn from north, radius v / ω, `tSec` in. */
function turning(speed, tSec, heightM = 10_000) {
  const omega = (3 * Math.PI) / 180;
  const radius = speed / omega;
  // Centre west of the start; heading north, turning left (towards west).
  const angle = omega * tSec;
  const east = -radius + radius * Math.cos(angle);
  const north = radius * Math.sin(angle);
  return Cesium.Cartesian3.fromDegrees(
    LON0 + east / mPerDegLon(LAT0),
    LAT0 + north / M_PER_DEG_LAT,
    heightM,
  );
}

/** Distance from p to the nearest point of a polyline. */
function distanceToPath(p, path) {
  let best = Infinity;
  const ab = new Cesium.Cartesian3();
  const ap = new Cesium.Cartesian3();
  const closest = new Cesium.Cartesian3();
  for (let i = 1; i < path.length; i++) {
    Cesium.Cartesian3.subtract(path[i], path[i - 1], ab);
    Cesium.Cartesian3.subtract(p, path[i - 1], ap);
    const len2 = Cesium.Cartesian3.magnitudeSquared(ab);
    const t =
      len2 > 0
        ? Math.max(0, Math.min(1, Cesium.Cartesian3.dot(ap, ab) / len2))
        : 0;
    Cesium.Cartesian3.add(
      path[i - 1],
      Cesium.Cartesian3.multiplyByScalar(ab, t, closest),
      closest,
    );
    best = Math.min(best, Cesium.Cartesian3.distance(p, closest));
  }
  return best;
}

const drawnCount = (fixes) => fixes.filter((fix) => fix.drawn).length;

test('one hour straight and level with a report every 15 s adds under 60 recorded points', () => {
  const speed = 230;
  const fixes = [];
  for (const t of [0, 15, 30])
    insertTrailFix(fixes, eastbound(speed, t), t * SEC, LIMIT);
  // Live order: a report arrives 30 s before the display reaches it, and the
  // drawn icon is recorded once a second.
  for (let t = 1; t <= 3_600; t++) {
    const reportAt = t + 30;
    if (reportAt % 15 === 0 && reportAt <= 3_600)
      insertTrailFix(fixes, eastbound(speed, reportAt), reportAt * SEC, LIMIT);
    recordTrailPoint(fixes, eastbound(speed, t), t * SEC, LIMIT);
  }
  assert.ok(
    drawnCount(fixes) < 60,
    `${drawnCount(fixes)} recorded points kept`,
  );
  assert.equal(fixes.filter((fix) => !fix.drawn).length, 241);
});

test('with no report at all, a straight leg keeps one point per 10 km and no more', () => {
  const speed = 230;
  const fixes = [];
  insertTrailFix(fixes, eastbound(speed, 0), 0, LIMIT);
  for (let t = 1; t <= 3_600; t++)
    recordTrailPoint(fixes, eastbound(speed, t), t * SEC, LIMIT);
  const legKm = (speed * 3_600) / 1_000;
  assert.equal(TRAIL_THIN_MAX_SPAN_M, 10_000);
  assert.ok(
    drawnCount(fixes) <= Math.ceil(legKm / 10) + 1,
    `${drawnCount(fixes)} points over ${legKm} km`,
  );
  for (let i = 1; i < fixes.length; i++)
    assert.ok(
      Cesium.Cartesian3.distance(fixes[i - 1].position, fixes[i].position) <=
        TRAIL_THIN_MAX_SPAN_M + speed,
    );
});

test('a standard-rate 180° turn keeps its curve: every recorded position stays within 30 m of the kept line', () => {
  const speed = 230;
  const fixes = [];
  const recorded = [];
  insertTrailFix(fixes, turning(speed, 0), 0, LIMIT);
  for (let t = 1; t <= 60; t++) {
    const position = turning(speed, t);
    recorded.push(position);
    recordTrailPoint(fixes, position, t * SEC, LIMIT);
  }
  const line = fixes.map((fix) => fix.position);
  assert.equal(TRAIL_THIN_TOLERANCE_M, 30);
  for (const position of recorded) {
    const off = distanceToPath(position, line);
    assert.ok(off <= TRAIL_THIN_TOLERANCE_M + 1, `${off.toFixed(1)} m off`);
  }
  assert.ok(drawnCount(fixes) < recorded.length, 'nothing was thinned');
  assert.ok(drawnCount(fixes) >= 6, 'the curve was flattened');
});

test('a climb off the straight line keeps its vertices', () => {
  const fixes = [];
  insertTrailFix(fixes, eastbound(200, 0, 1_000), 0, LIMIT);
  // 30 s level, then a 60 s climb of 20 m/s, then level again.
  const height = (t) => 1_000 + 20 * Math.min(60, Math.max(0, t - 30));
  const recorded = [];
  for (let t = 1; t <= 150; t++) {
    const position = eastbound(200, t, height(t));
    recorded.push(position);
    recordTrailPoint(fixes, position, t * SEC, LIMIT);
  }
  const line = fixes.map((fix) => fix.position);
  for (const position of recorded)
    assert.ok(distanceToPath(position, line) <= TRAIL_THIN_TOLERANCE_M + 1);
});

test('at the limit, old recorded points go before any report from the backfill', () => {
  const max = 300;
  const backfill = [];
  for (let i = 0; i < 100; i++)
    backfill.push({
      position: eastbound(200, i * 60 - 20_000),
      timeMs: (i * 60 - 20_000) * SEC,
      nullAltitude: false,
    });
  let fixes = [];
  insertTrailFix(fixes, turning(150, 0), 0, max);
  // A long series of turns keeps many recorded points.
  for (let t = 1; t <= 2_000; t++)
    recordTrailPoint(fixes, turning(150, t), t * SEC, max);
  assert.ok(drawnCount(fixes) > 150);
  fixes = joinTrailBackfill(
    {
      fixes: backfill.map((b) => ({ ...b, breakBefore: false })),
      breakAfter: false,
    },
    fixes,
    max,
  );
  assert.ok(fixes.length <= max);
  const reports = fixes.filter((fix) => !fix.drawn);
  assert.equal(reports.length, 101, 'a report was dropped');
  // More recording at the limit drops recorded points, never reports.
  for (let t = 2_001; t <= 2_400; t++)
    recordTrailPoint(fixes, turning(150, t), t * SEC, max);
  assert.ok(fixes.length <= max);
  assert.equal(fixes.filter((fix) => !fix.drawn).length, 101);
  // The recorded points that remain are the newest.
  const drawnTimes = fixes.filter((fix) => fix.drawn).map((fix) => fix.timeMs);
  assert.ok(Math.min(...drawnTimes) > 1_000 * SEC);
});
