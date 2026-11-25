import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  insertTrailFix,
  trailBodySegments,
  trailHeadCurvePoints,
} from './trailContinuity.js';

// A trail is the aircraft's reports and nothing else, each pair that is one
// path joined along the curve the icon is drawn along between them: no
// stretch it was drawn at between reports is kept, so a late report can
// never leave a kink.

const SEC = 1000;
const LIMIT = 2_000;
const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
  Cesium.Cartesian3.fromDegrees(-100, 40, 0),
);
const at = (e, n, u = 3_000) =>
  Cesium.Matrix4.multiplyByPoint(
    enu,
    new Cesium.Cartesian3(e, n, u),
    new Cesium.Cartesian3(),
  );

/** The sharpest turn (degrees) at any vertex of `line`, steps under 1 m skipped. */
function sharpestTurnDeg(line) {
  const u = new Cesium.Cartesian3();
  const v = new Cesium.Cartesian3();
  let worst = 0;
  for (let i = 1; i < line.length - 1; i++) {
    Cesium.Cartesian3.subtract(line[i], line[i - 1], u);
    Cesium.Cartesian3.subtract(line[i + 1], line[i], v);
    const lu = Cesium.Cartesian3.magnitude(u);
    const lv = Cesium.Cartesian3.magnitude(v);
    if (!(lu > 1 && lv > 1)) continue;
    const cos = Math.min(1, Cesium.Cartesian3.dot(u, v) / (lu * lv));
    worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
  }
  return worst;
}

// A 100 m/s aircraft in a left turn on a 2 km circle centred at (0, R),
// heading east at the origin, reporting every 15 s with its track.
const R = 2_000;
const W = 100 / R;
const circle = (t) => at(R * Math.sin(W * t), R - R * Math.cos(W * t));
const trackAt = (t) => (90 - (W * t * 180) / Math.PI + 360) % 360;

test('reports in a turn are joined along a smooth curve through each report', () => {
  const fixes = [];
  for (let t = 0; t <= 60; t += 15)
    insertTrailFix(fixes, circle(t), t * SEC, LIMIT, { track: trackAt(t) });
  assert.deepEqual(
    fixes.map((f) => f.timeMs),
    [0, 15, 30, 45, 60].map((s) => s * SEC),
  );
  const [line] = trailBodySegments(fixes, fixes.length);
  for (const f of fixes)
    assert.ok(
      line.some((p) => Cesium.Cartesian3.distance(p, f.position) < 0.01),
      'every report is on the line',
    );
  assert.ok(sharpestTurnDeg(line) < 3, `${sharpestTurnDeg(line)}°`);
  // On the circle, not across its chords.
  for (const p of line)
    assert.ok(
      Math.abs(Cesium.Cartesian3.distance(p, at(0, R)) - R) < 20,
      'a point off the turn',
    );
});

test('reports with no track are joined straight, report to report', () => {
  const fixes = [];
  for (let t = 0; t <= 60; t += 15)
    insertTrailFix(fixes, circle(t), t * SEC, LIMIT);
  const [line] = trailBodySegments(fixes, fixes.length);
  assert.equal(line.length, fixes.length);
});

test('two reports 60 s and 51 km apart are not joined', () => {
  const fixes = [];
  insertTrailFix(
    fixes,
    Cesium.Cartesian3.fromDegrees(-100, 40, 9_000),
    0,
    LIMIT,
    { track: 90 },
  );
  insertTrailFix(
    fixes,
    Cesium.Cartesian3.fromDegrees(-99.4, 40, 9_000),
    60 * SEC,
    LIMIT,
    { track: 90 },
  );
  assert.equal(trailBodySegments(fixes, fixes.length).length, 2);
  // Nor is the head drawn along a curve across them.
  assert.deepEqual(trailHeadCurvePoints(fixes, 1, 30 * SEC), []);
});

test('a report with no altitude keeps no position and breaks the line', () => {
  const fixes = [];
  insertTrailFix(fixes, circle(0), 0, LIMIT, { track: trackAt(0) });
  insertTrailFix(fixes, circle(15), 15 * SEC, LIMIT, { nullAltitude: true });
  insertTrailFix(fixes, circle(30), 30 * SEC, LIMIT, { track: trackAt(30) });
  assert.equal(fixes[1].position, null);
  assert.equal(trailBodySegments(fixes, fixes.length).length, 2);
});

test('an estimated report stands in only until the next received one', () => {
  // Out of receiver range a feed carries the aircraft on its last course; the
  // next received report is 900 m off that line. The guesses go, so the line
  // runs received report to received report.
  const fixes = [];
  insertTrailFix(fixes, at(0, 0), 0, LIMIT);
  insertTrailFix(fixes, at(1_500, 0), 15 * SEC, LIMIT, { estimated: true });
  insertTrailFix(fixes, at(3_000, 0), 30 * SEC, LIMIT, { estimated: true });
  assert.equal(fixes.length, 3);
  assert.equal(fixes[2].estimated, true);
  insertTrailFix(fixes, at(4_500, -900), 45 * SEC, LIMIT);
  assert.deepEqual(
    fixes.map((fix) => [fix.timeMs, fix.estimated === true]),
    [
      [0, false],
      [45 * SEC, false],
    ],
  );
  // 45 s and 4.6 km apart: still one path, joined.
  assert.equal(fixes[1].breakBefore, false);
  // A received report a sweep late, older than the guesses, takes them out too.
  insertTrailFix(fixes, at(6_000, -900), 60 * SEC, LIMIT, { estimated: true });
  insertTrailFix(fixes, at(5_000, -900), 50 * SEC, LIMIT);
  assert.deepEqual(
    fixes.map((fix) => fix.timeMs),
    [0, 45 * SEC, 50 * SEC],
  );
});

test('a report arriving late goes in time order and the curve stays smooth', () => {
  const fixes = [];
  for (const t of [0, 30, 15, 45])
    insertTrailFix(fixes, circle(t), t * SEC, LIMIT, { track: trackAt(t) });
  assert.deepEqual(
    fixes.map((f) => f.timeMs / SEC),
    [0, 15, 30, 45],
  );
  const [line] = trailBodySegments(fixes, fixes.length);
  assert.ok(sharpestTurnDeg(line) < 3);
});

test('the head runs along the curve to the next report and stops before the display time', () => {
  const fixes = [];
  insertTrailFix(fixes, circle(0), 0, LIMIT, { track: trackAt(0) });
  insertTrailFix(fixes, circle(15), 15 * SEC, LIMIT, { track: trackAt(15) });
  const head = trailHeadCurvePoints(fixes, 1, 10 * SEC);
  assert.ok(head.length > 5);
  const drawnAt = circle(10);
  const [body] = trailBodySegments(fixes, 1);
  // Body, head points, then the aircraft: one smooth line.
  assert.ok(sharpestTurnDeg([...body, ...head, drawnAt]) < 3);
  for (const p of head)
    assert.ok(Math.abs(Cesium.Cartesian3.distance(p, at(0, R)) - R) < 20);
});
