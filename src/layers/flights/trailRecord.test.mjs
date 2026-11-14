import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { bindRenderer } from '../../render/rendererOf.js';
import { createStubRenderer } from '../../render/stub/index.js';
import { createMotion } from './motion.js';
import { createFlightState } from './state.js';
import { createTracking } from './tracking.js';
import { RENDER_DELAY_SEC, STALE_ALPHA } from './policy.js';

// A tracked trail is the aircraft's reports joined along the curve the icon
// is drawn along between them, so the icon always sits on its trail and a
// late report can never leave a kink. These tests
// drive the real motion and display path frame by frame.

const SEC = 1000;
const ICAO = '00a001';
const T0 = Date.UTC(2026, 10, 9, 21, 0);

function fix(timeMs, lat, lon, heightM, velocity, track) {
  return {
    time: Cesium.JulianDate.fromDate(new Date(timeMs)),
    epochMs: timeMs,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    velocity,
    track,
  };
}

function services(trail, ground) {
  const names = [
    'picking',
    'sprites',
    'aircraftPresentation',
    'camera',
    'militaryRegistry',
    'labels',
    'meshFloor',
    'focus',
    'readout',
    'context',
    'render',
    'recession',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, {}])),
    aircraftPresentation: {
      isTr3b: () => false,
      tr3bTypeLabel: (id, label) => label,
    },
    focus: {
      nearFarScalarValueAtDistance: () => 1,
      clearFocusTarget() {},
      publishFocusTargetAt() {},
      publishFocusTargetFromCachedPosition() {},
    },
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
    trails: trail,
    geoid: { ensureGeoidReady: async () => {}, geoidHeight: () => 0 },
    groundFloor: {
      resolveGroundFloorCellsBounded: async () => {},
      cachedGroundFloor: ground,
      stickyFloorCell: (lat, lon) => ({ lat, lon }),
      neighborFloorM: () => null,
      floorAltitudeM: (alt, g) =>
        Number.isFinite(g) && Number.isFinite(alt)
          ? Math.max(alt, g + 1.5)
          : alt,
    },
  };
}

/**
 * Real motion, real display position and real tracking over one contact.
 * `frame()` runs one rendered frame: a frame of the stub renderer, whose
 * preRender pass moves the trail on and then draws its head.
 */
function harness({
  fixes,
  info,
  nowMs,
  ground = () => null,
  envelopeM = null,
}) {
  const segmentsCalls = [];
  let headPositions = [];
  const trail = {
    createTrail: () => ({
      setSegments(segments) {
        segmentsCalls.push(segments.map((segment) => segment.slice()));
      },
      setPositions(positions) {
        segmentsCalls.push([positions.slice()]);
      },
      setHead(positions) {
        headPositions = positions.slice();
      },
      setVisible() {},
      clear() {},
      destroy() {},
    }),
  };
  const svc = services(trail, ground);
  const flightState = createFlightState({
    services: svc,
    source: { label: 'Fixture aircraft' },
  });
  flightState.records.data.set(ICAO, info);
  // The scene, on the stub renderer: each frame runs its preRender pass
  // (the trail moves on, then its head is drawn) and counts as drawn.
  const renderer = createStubRenderer();
  flightState._viewer = {};
  bindRenderer(flightState._viewer, renderer);
  flightState._trackedIcao = ICAO;
  let clock = nowMs;
  flightState.now = () => clock;
  flightState._positionHistory.set(ICAO, fixes);
  const parts = {
    rendering: { _modelOwnsVisual: () => false, _modelSpec: () => ({}) },
    queries: { _contactLabel: (id, info) => info?.callsign || id },
  };
  parts.motion = createMotion({ flightState, services: svc, parts });
  if (envelopeM != null) {
    // A 3D model is the visual: its centre is the drawn position.
    parts.motion._trackedModelCenterWorld = () =>
      parts.motion._trackedDisplayCached();
    parts.motion._trackedModelEnvelopeM = () => envelopeM;
  }
  const tracking = createTracking({
    flightState,
    services: svc,
    parts,
    layer: {},
  });
  parts.tracking = tracking;
  const realDateNow = Date.now;
  Date.now = () => clock;
  // The live head the last frame drew (the trail's head, set each frame
  // before it draws).
  const head = () => headPositions;
  /** Drawn icon positions, one per frame. */
  const drawn = [];
  // Where the frame draws the icon: read in the same frame as the head.
  renderer.frame.on('preRender', () => {
    const icon = parts.motion._trackedDisplayPosition(ICAO);
    if (icon) drawn.push(Cesium.Cartesian3.clone(icon));
  });
  const frame = () => {
    renderer.frame.requestRender('test');
    renderer.testing.tick();
  };
  const run = (toMs, { frameMs = 100, readHead = true } = {}) => {
    while (clock < toMs) {
      clock = Math.min(toMs, clock + frameMs);
      frame({ readHead });
    }
  };
  return {
    flightState,
    tracking,
    motion: parts.motion,
    head,
    drawn,
    run,
    body: () => segmentsCalls.at(-1) ?? [],
    bodyPoints: () => (segmentsCalls.at(-1) ?? []).flat(),
    restore: () => {
      Date.now = realDateNow;
    },
  };
}

/**
 * The report a plane at `from` (speed and track as reported) gives at `toMs`
 * after a constant turn at `rateDps` (negative left), with `trackDeg` its track.
 */
function turnedFix(from, toMs, rateDps, trackDeg) {
  const seconds = (toMs - from.epochMs) / SEC;
  const turned = (rateDps * seconds * Math.PI) / 180;
  const r = from.velocity / Math.abs((rateDps * Math.PI) / 180);
  const h = (from.track * Math.PI) / 180;
  const fwd = [Math.sin(h), Math.cos(h)];
  const side = Math.sign(rateDps);
  // To the right of the heading for a right turn, the left for a left one.
  const right = [Math.cos(h), -Math.sin(h)];
  const along = r * Math.sin(Math.abs(turned));
  const across = side * r * (1 - Math.cos(turned));
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(from.position);
  const p = Cesium.Matrix4.multiplyByPoint(
    enu,
    new Cesium.Cartesian3(
      fwd[0] * along + right[0] * across,
      fwd[1] * along + right[1] * across,
      0,
    ),
    new Cesium.Cartesian3(),
  );
  const c = Cesium.Cartographic.fromCartesian(p);
  return fix(
    toMs,
    Cesium.Math.toDegrees(c.latitude),
    Cesium.Math.toDegrees(c.longitude),
    Cesium.Cartographic.fromCartesian(from.position).height,
    from.velocity,
    trackDeg,
  );
}

/** Distance from p to the nearest point of a polyline. */
function distanceToPath(p, path) {
  let best = Infinity;
  const ab = new Cesium.Cartesian3();
  const ap = new Cesium.Cartesian3();
  const closest = new Cesium.Cartesian3();
  if (path.length === 1) return Cesium.Cartesian3.distance(p, path[0]);
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

/** No vertex turns the line back sharper than 120° over a short step. */
function assertNoSpur(line, label) {
  const u = new Cesium.Cartesian3();
  const v = new Cesium.Cartesian3();
  for (let i = 1; i < line.length - 1; i++) {
    Cesium.Cartesian3.subtract(line[i], line[i - 1], u);
    Cesium.Cartesian3.subtract(line[i + 1], line[i], v);
    const lu = Cesium.Cartesian3.magnitude(u);
    const lv = Cesium.Cartesian3.magnitude(v);
    if (!(lu > 0 && lv > 0) || Math.min(lu, lv) > 500) continue;
    const cos = Cesium.Cartesian3.dot(u, v) / (lu * lv);
    assert.ok(
      cos >= -0.5,
      `${label}: spur at vertex ${i} of ${line.length} (turn ${(
        (Math.acos(cos) * 180) /
        Math.PI
      ).toFixed(0)}°)`,
    );
  }
}

/** No vertex of `line` turns it more than `maxDeg` (steps under 1 m skipped). */
function assertSmooth(line, maxDeg, label) {
  const u = new Cesium.Cartesian3();
  const v = new Cesium.Cartesian3();
  for (let i = 1; i < line.length - 1; i++) {
    Cesium.Cartesian3.subtract(line[i], line[i - 1], u);
    Cesium.Cartesian3.subtract(line[i + 1], line[i], v);
    const lu = Cesium.Cartesian3.magnitude(u);
    const lv = Cesium.Cartesian3.magnitude(v);
    if (!(lu > 1 && lv > 1)) continue;
    const deg =
      (Math.acos(Math.min(1, Cesium.Cartesian3.dot(u, v) / (lu * lv))) * 180) /
      Math.PI;
    assert.ok(deg <= maxDeg, `${label}: ${deg.toFixed(1)}° at vertex ${i}`);
  }
}

const indexOfPoint = (line, p) =>
  line.findIndex((q) => Cesium.Cartesian3.distance(p, q) < 0.01);

// A departing jet: four northbound climb reports, then a left turn through
// west to south with no report while the icon flies it.
function departure() {
  const fixes = [
    fix(T0, 37.6329, -122.3661, 213, 85, 8),
    fix(T0 + 30 * SEC, 37.6542, -122.3616, 495, 95, 0),
    fix(T0 + 60 * SEC, 37.6813, -122.3615, 808, 104, 350),
    fix(T0 + 90 * SEC, 37.7066, -122.3755, 1257, 112, 340),
  ];
  const info = {
    altitude: 1257,
    renderAltitudeM: 1257,
    rawLat: 37.7066,
    rawLon: -122.3755,
    velocity: 112,
    true_track: 340,
    turnRateDps: -2,
    onGround: false,
    wasAirborne: true,
    lastContactEpochMs: T0 + 200 * SEC,
  };
  return { fixes, info };
}

test('a report from a turn lands while the icon coasts: the trail runs report to report along their curve, with no kink, and the icon is on it', () => {
  const { fixes, info } = departure();
  const start = T0 + 90 * SEC + RENDER_DELAY_SEC * SEC;
  const h = harness({ fixes, info, nowMs: start });
  try {
    h.tracking._startTrail(ICAO);
    // 40 s with no new report: past it, the icon flies straight on.
    h.run(start + 40 * SEC);
    // The next report is where the plane really was 60 s after the last one,
    // still ahead of the display time: through a 2°/s left turn, heading 220°.
    const report = turnedFix(fixes[3], T0 + 150 * SEC, -2, 220);
    fixes.push(report);
    info.true_track = 220;
    h.tracking._appendTrailFix(
      Cesium.Cartesian3.clone(report.position),
      report.epochMs,
      { track: 220 },
    );
    // The display passes the new report.
    h.run(start + 75 * SEC);
    const line = h.bodyPoints();
    const a = indexOfPoint(line, fixes[3].position);
    const b = indexOfPoint(line, report.position);
    assert.ok(a >= 0 && b > a, 'both reports are on the trail');
    const between = line.slice(a, b + 1);
    // A curve, not the chord, and smooth: no vertex turns more than 3°.
    const chord = [fixes[3].position, report.position];
    assert.ok(Math.max(...between.map((p) => distanceToPath(p, chord))) > 300);
    assertSmooth(between, 3, 'trail');
    // Eased onto the curve, the icon is drawn on its trail.
    const trail = [...line, ...h.head()];
    for (const p of h.drawn.slice(-100)) {
      const off = distanceToPath(p, trail);
      assert.ok(off < 3, `drawn ${off.toFixed(1)} m off the trail`);
    }
    assertNoSpur(line, 'trail');
    assertNoSpur(h.head(), 'head');
  } finally {
    h.restore();
  }
});

test('a fresh report after a hold resumes with no backward spur', () => {
  const fixes = [0, 1, 2, 3].map((i) =>
    fix(T0 + i * 15 * SEC, 40, -100 + i * 0.04, 10_000, 230, 90),
  );
  const info = {
    altitude: 10_000,
    renderAltitudeM: 10_000,
    rawLat: 40,
    rawLon: -100 + 0.12,
    velocity: 230,
    true_track: 90,
    turnRateDps: 0,
    onGround: false,
    wasAirborne: true,
    lastContactEpochMs: T0 + 45 * SEC,
  };
  const start = T0 + 45 * SEC + RENDER_DELAY_SEC * SEC;
  const h = harness({ fixes, info, nowMs: start });
  try {
    h.tracking._startTrail(ICAO);
    // The contact coasts five minutes, then holds; recording stops while it
    // holds.
    h.run(start + 320 * SEC);
    const held = h.bodyPoints().length;
    h.run(start + 360 * SEC);
    assert.equal(h.bodyPoints().length, held, 'the trail grew during a hold');
    // A fresh report, a little north of the track, ahead of the display.
    const display = start + 360 * SEC - RENDER_DELAY_SEC * SEC;
    // Just past where it held: five minutes and ten seconds at 230 m/s.
    const aheadDeg = (230 * 310) / (111_320 * Math.cos((40 * Math.PI) / 180));
    const fresh = fix(
      display + 10 * SEC,
      40.01,
      -100 + 0.12 + aheadDeg,
      10_000,
      230,
      80,
    );
    fixes.push(fresh);
    info.lastContactEpochMs = fresh.epochMs;
    h.tracking._appendTrailFix(
      Cesium.Cartesian3.clone(fresh.position),
      fresh.epochMs,
    );
    h.run(start + 390 * SEC);
    assertNoSpur(h.bodyPoints(), 'trail');
    assertNoSpur(h.head(), 'head');
    assert.ok(indexOfPoint(h.bodyPoints(), fresh.position) >= 0);
  } finally {
    h.restore();
  }
});

test('with the head hidden the body moves on as the display passes reports, and untracking clears the trail', () => {
  const { fixes, info } = departure();
  // Drawn 30 s after the first report: the body holds the first two.
  const start = T0 + 30 * SEC + RENDER_DELAY_SEC * SEC;
  const h = harness({ fixes, info, nowMs: start });
  try {
    h.tracking._startTrail(ICAO);
    h.run(start + 1 * SEC);
    assert.ok(
      Cesium.Cartesian3.distance(h.bodyPoints().at(-1), fixes[1].position) <
        0.01,
    );
    // Cockpit view: the head is hidden, the body still moves on.
    h.run(start + 61 * SEC, { readHead: false });
    assert.ok(
      Cesium.Cartesian3.distance(h.bodyPoints().at(-1), fixes[3].position) <
        0.01,
      'the body stopped advancing',
    );
    h.tracking._clearTrail();
    assert.equal(h.flightState._trailFixes.length, 0);
    // A new track of the same plane starts from its reports.
    h.tracking._startTrail(ICAO);
    assert.equal(h.flightState._trailFixes.length, fixes.length);
  } finally {
    h.restore();
  }
});

test('a live fix with no altitude breaks the line and puts no point at an invented height', () => {
  const { fixes, info } = departure();
  const start = T0 + 90 * SEC + RENDER_DELAY_SEC * SEC;
  const h = harness({ fixes, info, nowMs: start });
  try {
    h.tracking._startTrail(ICAO);
    const invented = Cesium.Cartesian3.fromDegrees(-122.38, 37.71, 10_000);
    h.tracking._appendTrailFix(invented, T0 + 95 * SEC, { nullAltitude: true });
    const later = Cesium.Cartesian3.fromDegrees(-122.39, 37.715, 1400);
    h.tracking._appendTrailFix(later, T0 + 100 * SEC);
    h.run(T0 + 100 * SEC + RENDER_DELAY_SEC * SEC + SEC, { frameMs: 500 });
    for (const point of h.bodyPoints())
      assert.ok(Cesium.Cartographic.fromCartesian(point).height < 5_000);
    // The reports on either side of it are not joined.
    const segments = h.body();
    const holding = (p) =>
      segments.findIndex((segment) =>
        segment.some((q) => Cesium.Cartesian3.distance(p, q) < 0.01),
      );
    assert.notEqual(holding(fixes[3].position), holding(later));
  } finally {
    h.restore();
  }
});

test('with a 3D model as the visual, the trail stops outside the model and the head runs from there to the plane', () => {
  const { fixes, info } = departure();
  info.turnRateDps = 0;
  const start = T0 + 90 * SEC + RENDER_DELAY_SEC * SEC;
  const envelopeM = 300;
  const h = harness({ fixes, info, nowMs: start, envelopeM });
  try {
    h.tracking._startTrail(ICAO);
    h.run(start + 30 * SEC);
    const icon = h.drawn.at(-1);
    const body = h.bodyPoints();
    const head = h.head();
    assert.ok(head.length >= 2, 'no head is drawn');
    assert.ok(Cesium.Cartesian3.distance(head.at(-1), icon) < 0.01);
    // No trail point inside the model, and the head starts where the body ends.
    for (const point of body)
      assert.ok(Cesium.Cartesian3.distance(point, icon) >= envelopeM - 1);
    assert.ok(Cesium.Cartesian3.distance(head[0], body.at(-1)) < 0.01);
    // Body and head together follow where the icon was drawn.
    const line = body.concat(head);
    for (const point of h.drawn) {
      const off = distanceToPath(point, line);
      assert.ok(off < 35, `drawn icon ${off.toFixed(0)} m off the trail`);
    }
  } finally {
    h.restore();
  }
});

test('a report the display already passed replaces the guess drawn after it, with no spike', () => {
  const { fixes, info } = departure();
  const start = T0 + 90 * SEC + RENDER_DELAY_SEC * SEC;
  const h = harness({ fixes, info, nowMs: start });
  try {
    h.tracking._startTrail(ICAO);
    h.run(start + 40 * SEC);
    // A report for 10 s before the display time, 400 m inside the drawn arc.
    const guess = h.motion._deadReckon(
      ICAO,
      new Cesium.Cartesian3(),
      Cesium.JulianDate.fromDate(new Date(T0 + 120 * SEC)),
    );
    const c = Cesium.Cartographic.fromCartesian(guess);
    const report = fix(
      T0 + 120 * SEC,
      Cesium.Math.toDegrees(c.latitude) - 400 / 111_320,
      Cesium.Math.toDegrees(c.longitude),
      c.height,
      112,
      250,
    );
    fixes.push(report);
    info.true_track = 250;
    h.tracking._appendTrailFix(
      Cesium.Cartesian3.clone(report.position),
      report.epochMs,
    );
    h.run(start + 55 * SEC);
    // Reports only: nothing drawn between them is kept.
    assert.deepEqual(
      h.flightState._trailFixes.map((entry) => entry.timeMs),
      fixes.map((f) => f.epochMs),
      'the trail holds the reports and nothing else',
    );
    const line = h.bodyPoints();
    assert.ok(indexOfPoint(line, report.position) >= 0);
    assertNoSpur(line, 'trail');
  } finally {
    h.restore();
  }
});

test('a history report at an invented height is seeded with no position, and the trail holds only reports', () => {
  const { fixes, info } = departure();
  fixes[3].inventedHeight = true;
  const start = T0 + 90 * SEC + RENDER_DELAY_SEC * SEC;
  const h = harness({ fixes, info, nowMs: start });
  try {
    h.tracking._startTrail(ICAO);
    const seeded = h.flightState._trailFixes.find(
      (entry) => entry.timeMs === fixes[3].epochMs,
    );
    assert.equal(seeded.position, null);
    assert.equal(seeded.nullAltitude, true);
    h.run(start + 10 * SEC);
    assert.deepEqual(
      h.flightState._trailFixes.map((entry) => entry.timeMs),
      fixes.map((f) => f.epochMs),
      'the trail holds the reports and nothing else',
    );
  } finally {
    h.restore();
  }
});

// A turboprop at FL210 flying east out of receiver coverage: its last
// position is at T0 + 30 s, and contact goes on for four more minutes.
function outOfCoverage() {
  const fixes = [
    fix(T0, 43, -108.1, 6_400, 140, 90),
    fix(T0 + 30 * SEC, 43, -108.05, 6_400, 140, 90),
  ];
  const info = {
    altitude: 6_400,
    renderAltitudeM: 6_400,
    rawLat: 43,
    rawLon: -108.05,
    velocity: 140,
    true_track: 90,
    callsign: 'TEST7',
    turnRateDps: 0,
    onGround: false,
    wasAirborne: true,
    lastContactEpochMs: T0 + 30 * SEC + 240 * SEC,
  };
  return { fixes, info };
}

/** Display time (ms) `afterSec` past the last report. */
const pastReport = (afterSec) =>
  T0 + 30 * SEC + RENDER_DELAY_SEC * SEC + afterSec * SEC;

test('a plane that stops reporting keeps moving dimmed as STALE from its first missed update, then stops as SIGNAL LOST', () => {
  const { fixes, info } = outOfCoverage();
  const h = harness({ fixes, info, nowMs: pastReport(-5) });
  try {
    h.tracking._startTrail(ICAO);
    h.run(pastReport(30));
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: '',
      dimmed: false,
    });
    assert.equal(h.tracking._trackedIconColor()[3], 1);
    // The first missed update.
    h.flightState.records.missingPolls.set(ICAO, 1);
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: 'STALE',
      dimmed: true,
    });
    assert.match(h.tracking._trackedLabelText(ICAO), /STALE/);
    // Drawn with the fleet's stale fade.
    assert.equal(h.tracking._trackedIconColor()[3], STALE_ALPHA);
    // Still moving well past 90 s.
    h.run(pastReport(200));
    assert.ok(
      Cesium.Cartesian3.distance(h.drawn.at(-1), h.drawn.at(-11)) > 100,
    );
    // The coast ends 300 s past the report; the plane stops there.
    h.run(pastReport(310));
    h.run(pastReport(330));
    assert.ok(
      Cesium.Cartesian3.distance(h.drawn.at(-1), h.drawn.at(-50)) < 0.01,
    );
    assert.deepEqual(
      h.flightState._trailFixes.map((entry) => entry.timeMs),
      fixes.map((f) => f.epochMs),
      'the trail holds the reports and nothing else',
    );
    // 330 s of display past the report is 330 s + the display delay of wall time.
    const minutes = Math.floor((330 + RENDER_DELAY_SEC) / 60);
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: `SIGNAL LOST · ${minutes} min`,
      dimmed: true,
    });
    assert.match(
      h.tracking._trackedLabelText(ICAO),
      new RegExp(`SIGNAL LOST · ${minutes} min`),
    );
  } finally {
    h.restore();
  }
});

test('a plane held at its last report shows SIGNAL LOST in seconds under a minute', () => {
  // Its last report is 100 m above a known ground height: it holds there.
  const { fixes, info } = outOfCoverage();
  const h = harness({
    fixes,
    info,
    nowMs: pastReport(-5),
    ground: () => 6_300,
  });
  try {
    h.tracking._startTrail(ICAO);
    h.flightState.records.missingPolls.set(ICAO, 1);
    h.run(pastReport(10));
    assert.ok(10 + RENDER_DELAY_SEC < 60);
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: `SIGNAL LOST · ${10 + RENDER_DELAY_SEC} s`,
      dimmed: true,
    });
  } finally {
    h.restore();
  }
});

test('a report arriving 200 s into a coast: the plane eases onto it with no jump, and the trail runs report to report', () => {
  const { fixes, info } = outOfCoverage();
  const h = harness({ fixes, info, nowMs: pastReport(-5) });
  try {
    h.tracking._startTrail(ICAO);
    h.run(pastReport(200));
    // Heard again: the report is for 10 s before the display time, 2 km north
    // of where the coast put it.
    const at = T0 + 30 * SEC + 190 * SEC;
    const guess = h.motion._deadReckon(
      ICAO,
      new Cesium.Cartesian3(),
      Cesium.JulianDate.fromDate(new Date(at)),
    );
    const c = Cesium.Cartographic.fromCartesian(guess);
    const report = fix(
      at,
      Cesium.Math.toDegrees(c.latitude) + 2_000 / 111_320,
      Cesium.Math.toDegrees(c.longitude),
      c.height,
      140,
      90,
    );
    fixes.push(report);
    h.tracking._appendTrailFix(
      Cesium.Cartesian3.clone(report.position),
      report.epochMs,
      { track: 90 },
    );
    // Reports only: nothing the coast drew is kept.
    assert.deepEqual(
      h.flightState._trailFixes.map((e) => e.timeMs),
      fixes.map((f) => f.epochMs),
    );
    const from = h.drawn.length;
    h.run(pastReport(240));
    const after = h.drawn.slice(from - 1);
    // Frames are 100 ms apart: 14 m at 140 m/s. The ease adds at most 30 %.
    for (let i = 1; i < after.length; i++)
      assert.ok(
        Cesium.Cartesian3.distance(after[i], after[i - 1]) < 14 * 1.5,
        'the plane jumped instead of easing',
      );
    // Eased onto the path from the report: 50 s on from it at 140 m/s.
    const off = Cesium.Cartesian3.distance(after.at(-1), report.position);
    assert.ok(
      Math.abs(off - 140 * 50) < 150,
      `${off.toFixed(0)} m from the report`,
    );
    assert.ok(indexOfPoint(h.bodyPoints(), report.position) >= 0);
  } finally {
    h.restore();
  }
});

test('a tracked plane that stops reporting: STALE from the first missed poll, SIGNAL LOST after the five-minute coast, kept at 9 min, removed at 10 min', () => {
  const { fixes, info } = outOfCoverage();
  const fixMs = fixes.at(-1).epochMs;
  // Contact stops with the position: the plane left coverage.
  info.lastContactEpochMs = fixMs;
  info.newestFixMs = fixMs;
  const h = harness({ fixes, info, nowMs: fixMs + 5 * SEC });
  try {
    h.tracking._startTrail(ICAO);
    const records = h.flightState.records;
    const polls = new Map();
    let removedAtSec = null;
    // A poll every 10 s that lists the plane without a position.
    for (let afterSec = 10; afterSec <= 660; afterSec += 10) {
      h.run(fixMs + afterSec * SEC, { frameMs: 500, readHead: false });
      const result = records.absence(ICAO, {
        complete: true,
        retainIds: new Set([ICAO]),
        likelyLanded: false,
        tracked: true,
      });
      if (result === 'remove') {
        removedAtSec = afterSec;
        break;
      }
      polls.set(afterSec, {
        cue: h.tracking._trackedStaleCue(ICAO),
        drawn: Cesium.Cartesian3.clone(h.drawn.at(-1)),
      });
    }
    // Wall time when the display reaches the end of the coast.
    const coastEndSec = 300 + RENDER_DELAY_SEC;
    for (const [afterSec, { cue }] of polls) {
      if (afterSec <= coastEndSec) {
        assert.deepEqual(cue, { text: 'STALE', dimmed: true }, `${afterSec} s`);
      } else {
        assert.deepEqual(
          cue,
          {
            text: `SIGNAL LOST · ${Math.floor(afterSec / 60)} min`,
            dimmed: true,
          },
          `${afterSec} s`,
        );
      }
    }
    const moved = (a, b) =>
      Cesium.Cartesian3.distance(polls.get(a).drawn, polls.get(b).drawn);
    // Moving through the coast, still at its last speed at four minutes.
    assert.ok(Math.abs(moved(230, 240) - 140 * 10) < 20);
    // Stopped once the coast has ended.
    const after = Math.ceil(coastEndSec / 10) * 10;
    assert.ok(moved(after, 540) < 0.01);
    assert.equal(polls.get(300).cue.text, 'STALE');
    assert.deepEqual(polls.get(540).cue, {
      text: 'SIGNAL LOST · 9 min',
      dimmed: true,
    });
    assert.equal(removedAtSec, 600);
  } finally {
    h.restore();
  }
});

test('a repeated old fix counts as a missed update for the tracked plane', () => {
  const { fixes, info } = outOfCoverage();
  const h = harness({ fixes, info, nowMs: pastReport(-5) });
  try {
    h.tracking._startTrail(ICAO);
    h.run(pastReport(-2));
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: '',
      dimmed: false,
    });
    // The feed re-sends the last position: its fix time did not advance.
    h.flightState.records.fixRepeated.add(ICAO);
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: 'STALE',
      dimmed: true,
    });
    assert.equal(h.tracking._trackedIconColor()[3], STALE_ALPHA);
    assert.equal(h.flightState.records.missingPolls.has(ICAO), false);
  } finally {
    h.restore();
  }
});

test('a stalled feed dims the tracked plane as STALE', () => {
  const { fixes, info } = outOfCoverage();
  const h = harness({ fixes, info, nowMs: pastReport(-5) });
  try {
    h.tracking._startTrail(ICAO);
    h.run(pastReport(-2));
    // The whole feed is backing off: no poll counts a miss, and no newer
    // position is coming in.
    h.flightState.feed._backoff = true;
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: 'STALE',
      dimmed: true,
    });
    assert.equal(h.tracking._trackedIconColor()[3], STALE_ALPHA);
    assert.equal(h.flightState.records.missingPolls.has(ICAO), false);
  } finally {
    h.restore();
  }
});

test('a report arriving after the plane has stopped far back: it jumps onto the new path, and the trail runs report to report with no spur', () => {
  const { fixes, info } = outOfCoverage();
  info.lastContactEpochMs = fixes.at(-1).epochMs;
  const h = harness({ fixes, info, nowMs: pastReport(-5) });
  try {
    h.tracking._startTrail(ICAO);
    h.run(pastReport(360));
    const stop = Cesium.Cartesian3.clone(h.drawn.at(-1));
    assert.ok(Cesium.Cartesian3.distance(stop, h.drawn.at(-100)) < 0.01);
    // Heard again, for 20 s before the display time: the plane flew on, a
    // little north of its old heading, 8 km past where it stopped.
    const at = T0 + 30 * SEC + 340 * SEC;
    const lonDeg =
      -108.05 + (140 * 340) / (111_320 * Math.cos((43 * Math.PI) / 180));
    const report = fix(at, 43 + 1_000 / 111_320, lonDeg, 6_400, 140, 90);
    fixes.push(report);
    h.tracking._appendTrailFix(
      Cesium.Cartesian3.clone(report.position),
      report.epochMs,
      { track: 90 },
    );
    const from = h.drawn.length;
    h.run(pastReport(365));
    const after = h.drawn.slice(from);
    // On the path from the report at once: 25 s on from it at 140 m/s.
    const off = Cesium.Cartesian3.distance(after.at(-1), report.position);
    assert.ok(Math.abs(off - 140 * 25) < 150, `${off.toFixed(0)} m`);
    assertNoSpur(h.bodyPoints(), 'trail');
    assertNoSpur(h.head(), 'head');
    assert.ok(indexOfPoint(h.bodyPoints(), report.position) >= 0);
  } finally {
    h.restore();
  }
});
