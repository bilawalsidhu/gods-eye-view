import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMotion } from './motion.js';
import { createFlightState } from './state.js';
import { createTracking } from './tracking.js';
import { RENDER_DELAY_SEC, STALE_ALPHA } from './policy.js';

// A tracked military contact's trail between reports is the path its icon
// was drawn along, recorded from the real display path frame by frame.

const SEC = 1000;
const ICAO = '00a004';
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
      publishFocusTargetFromCachedPosition() {},
    },
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
    trails: trail,
    geoid: { ensureGeoidReady: async () => {}, geoidHeight: () => 0 },
    groundFloor: {
      resolveGroundFloorCellsBounded: async () => {},
      cachedGroundFloor: ground,
      floorAltitudeM: (alt, g) =>
        Number.isFinite(g) && Number.isFinite(alt)
          ? Math.max(alt, g + 1.5)
          : alt,
    },
  };
}

/**
 * Real motion, real display position and real tracking over one contact.
 * `frame()` runs one rendered frame: the layer's preRender work, then the
 * head callback, as Cesium does.
 */
function harness({ fixes, info, nowMs, ground = () => null }) {
  const segmentsCalls = [];
  let inHead = false;
  const trail = {
    createTrail: () => ({
      setSegments(segments) {
        assert.ok(
          !inHead,
          'the trail body was rebuilt inside the head callback',
        );
        segmentsCalls.push(segments.map((segment) => segment.slice()));
      },
      setPositions(positions) {
        assert.ok(
          !inHead,
          'the trail body was rebuilt inside the head callback',
        );
        segmentsCalls.push([positions.slice()]);
      },
      setVisible() {},
      clear() {},
      destroy() {},
    }),
  };
  const svc = services(trail, ground);
  const flightState = createFlightState({ services: svc, source: {} });
  flightState.records.data.set(ICAO, info);
  let frameNumber = 0;
  const added = [];
  let entityChanges = 0;
  flightState._viewer = {
    isDestroyed: () => false,
    scene: {
      frameState: {
        get frameNumber() {
          return frameNumber;
        },
      },
    },
    entities: {
      add(definition) {
        entityChanges += 1;
        added.push(definition);
        return definition;
      },
      remove() {
        entityChanges += 1;
      },
    },
  };
  flightState._trackedIcao = ICAO;
  let clock = nowMs;
  flightState.now = () => clock;
  flightState._positionHistory.set(ICAO, fixes);
  const parts = {
    rendering: { _modelOwnsVisual: () => false, _modelSpec: () => ({}) },
    queries: {
      _toCleanText: (value) => (typeof value === 'string' ? value.trim() : ''),
      _formatAltitude: (ft) => `${ft} ft`,
    },
  };
  parts.motion = createMotion({ flightState, services: svc, parts });
  const tracking = createTracking({
    flightState,
    services: svc,
    parts,
    layer: {},
  });
  parts.tracking = tracking;
  const realDateNow = Date.now;
  Date.now = () => clock;
  const headEntity = () =>
    added.find((definition) =>
      String(definition.id).startsWith('gev-trail:mil-head-'),
    );
  const head = () => {
    const before = entityChanges;
    inHead = true;
    try {
      return headEntity().polyline.positions.getValue();
    } finally {
      inHead = false;
      assert.equal(
        entityChanges,
        before,
        'the head callback added or removed an entity',
      );
    }
  };
  /** Drawn icon positions, one per frame. */
  const drawn = [];
  const frame = ({ readHead = true } = {}) => {
    frameNumber += 1;
    tracking._trailTick();
    const icon = parts.motion._trackedDisplayPosition(ICAO);
    if (icon) drawn.push(Cesium.Cartesian3.clone(icon));
    if (readHead) head();
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
    altitudeFt: 4_124,
    renderAltitudeM: 1257,
    rawLat: 37.7066,
    rawLon: -122.3755,
    speedMps: 112,
    track: 340,
    turnRateDps: -2,
    onGround: false,
    wasAirborne: true,
    lastContactEpochMs: T0 + 200 * SEC,
  };
  return { fixes, info };
}

test('military: a report newer than the display time arrives mid-turn, and the trail between the reports stays on the drawn arc', () => {
  const { fixes, info } = departure();
  const start = T0 + 90 * SEC + RENDER_DELAY_SEC * SEC;
  const h = harness({ fixes, info, nowMs: start });
  try {
    h.tracking._startTrail(ICAO);
    // 40 s of turn with no new report: the icon flies the arc.
    h.run(start + 40 * SEC);
    const arc = h.drawn.slice();
    // The next report is where the plane really was 60 s after the last one,
    // still ahead of the display time (normal 30 s delay, slow feed). The icon
    // now interpolates the straight line between the two reports and is eased
    // onto it.
    const at60 = h.motion._deadReckon(
      ICAO,
      new Cesium.Cartesian3(),
      Cesium.JulianDate.fromDate(new Date(T0 + 150 * SEC)),
    );
    const c = Cesium.Cartographic.fromCartesian(at60);
    const report = fix(
      T0 + 150 * SEC,
      Cesium.Math.toDegrees(c.latitude),
      Cesium.Math.toDegrees(c.longitude),
      c.height,
      112,
      220,
    );
    fixes.push(report);
    info.track = 220;
    h.tracking._appendTrailFix(
      Cesium.Cartesian3.clone(report.position),
      report.epochMs,
    );
    // The display passes the new report.
    h.run(start + 75 * SEC);
    const line = h.bodyPoints();
    const from = indexOfPoint(line, fixes[3].position);
    const to = indexOfPoint(line, report.position);
    assert.ok(from >= 0 && to > from, 'both reports are on the trail');
    const between = line.slice(from, to + 1);
    // Every vertex between the reports is where the icon was drawn...
    const drawnPath = [fixes[3].position, ...h.drawn, report.position];
    for (const vertex of between) {
      const off = distanceToPath(vertex, drawnPath);
      assert.ok(
        off < 50,
        `trail vertex ${off.toFixed(0)} m off the drawn path`,
      );
    }
    // ...and the arc the icon flew is still there: no straight chord. (The
    // arc strays far from the chord, so a chord would fail this.)
    const chord = [fixes[3].position, report.position];
    assert.ok(Math.max(...arc.map((p) => distanceToPath(p, chord))) > 300);
    // The last 10 s of the arc are exempt: the correction pulled the icon back
    // over them, and keeping them would fold the line back on itself.
    for (const point of arc.slice(0, -100)) {
      const off = distanceToPath(point, between);
      assert.ok(off < 50, `drawn arc point ${off.toFixed(0)} m from the trail`);
    }
    assertNoSpur(line, 'trail');
    assertNoSpur(h.head(), 'head');
  } finally {
    h.restore();
  }
});

test('military: a report the display already passed replaces the guess drawn after it, with no spike', () => {
  const { fixes, info } = departure();
  const start = T0 + 90 * SEC + RENDER_DELAY_SEC * SEC;
  const h = harness({ fixes, info, nowMs: start });
  try {
    h.tracking._startTrail(ICAO);
    h.run(start + 40 * SEC);
    const displayMs = T0 + 130 * SEC;
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
    info.track = 250;
    h.tracking._appendTrailFix(
      Cesium.Cartesian3.clone(report.position),
      report.epochMs,
    );
    h.run(start + 55 * SEC);
    const recorded = h.flightState._trailFixes.filter((entry) => entry.drawn);
    // Nothing recorded between the report and the end of the ease.
    assert.deepEqual(
      recorded
        .filter(
          (entry) =>
            entry.timeMs > report.epochMs && entry.timeMs < displayMs + 900,
        )
        .map((entry) => entry.timeMs - T0),
      [],
    );
    const line = h.bodyPoints();
    assert.ok(indexOfPoint(line, report.position) >= 0);
    assertNoSpur(line, 'trail');
  } finally {
    h.restore();
  }
});

test('military: a history report at an invented height is seeded with no position, and nothing is recorded next to it', () => {
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
    assert.equal(
      h.flightState._trailFixes.filter((entry) => entry.drawn).length,
      0,
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
    altitudeFt: 21_000,
    renderAltitudeM: 6_400,
    rawLat: 43,
    rawLon: -108.05,
    speedMps: 140,
    track: 90,
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

test('military: a plane that stops reporting keeps moving dimmed as STALE from its first missed update, then stops as SIGNAL LOST', () => {
  const { fixes, info } = outOfCoverage();
  const h = harness({ fixes, info, nowMs: pastReport(-5) });
  try {
    h.tracking._startTrail(ICAO);
    h.run(pastReport(30));
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: '',
      dimmed: false,
    });
    assert.equal(h.tracking._trackedIconColor().alpha, 1);
    // The first missed update.
    h.flightState.records.missingPolls.set(ICAO, 1);
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: 'STALE',
      dimmed: true,
    });
    assert.match(
      h.tracking._buildTrackedLabel(h.flightState.records.data.get(ICAO), ICAO),
      /STALE/,
    );
    // Drawn with the fleet's stale fade.
    assert.equal(h.tracking._trackedIconColor().alpha, STALE_ALPHA);
    // Still moving well past 90 s.
    h.run(pastReport(200));
    assert.ok(
      Cesium.Cartesian3.distance(h.drawn.at(-1), h.drawn.at(-11)) > 100,
    );
    // The coast ends 300 s past the report; the plane stops there.
    h.run(pastReport(310));
    const recorded = h.flightState._trailFixes.filter((e) => e.drawn).length;
    h.run(pastReport(330));
    assert.ok(
      Cesium.Cartesian3.distance(h.drawn.at(-1), h.drawn.at(-50)) < 0.01,
    );
    assert.equal(
      h.flightState._trailFixes.filter((e) => e.drawn).length,
      recorded,
      'the trail kept recording a stopped plane',
    );
    // 330 s of display past the report is 330 s + the display delay of wall time.
    const minutes = Math.floor((330 + RENDER_DELAY_SEC) / 60);
    assert.deepEqual(h.tracking._trackedStaleCue(ICAO), {
      text: `SIGNAL LOST · ${minutes} min`,
      dimmed: true,
    });
    assert.match(
      h.tracking._buildTrackedLabel(h.flightState.records.data.get(ICAO), ICAO),
      new RegExp(`SIGNAL LOST · ${minutes} min`),
    );
  } finally {
    h.restore();
  }
});

test('military: a plane held at its last report shows SIGNAL LOST in seconds under a minute', () => {
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

test('military: a report arriving 200 s into a coast: the plane eases onto it and the trail drops what was drawn after it', () => {
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
    );
    assert.deepEqual(
      h.flightState._trailFixes.filter(
        (e) => e.drawn && e.timeMs > report.epochMs,
      ),
      [],
    );
    const from = h.drawn.length;
    h.run(pastReport(203));
    const after = h.drawn.slice(from - 1);
    for (let i = 1; i < after.length; i++)
      assert.ok(
        Cesium.Cartesian3.distance(after[i], after[i - 1]) < 400,
        'the plane jumped instead of easing',
      );
    // Eased onto the path from the report: 13 s on from it at 140 m/s.
    const off = Cesium.Cartesian3.distance(after.at(-1), report.position);
    assert.ok(
      Math.abs(off - 140 * 13) < 150,
      `${off.toFixed(0)} m from the report`,
    );
  } finally {
    h.restore();
  }
});

test('military: a tracked plane that stops reporting: STALE from the first missed poll, SIGNAL LOST after the five-minute coast, kept at 9 min, removed at 10 min', () => {
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

test('military: a repeated old fix counts as a missed update for the tracked plane', () => {
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
    assert.equal(h.tracking._trackedIconColor().alpha, STALE_ALPHA);
    assert.equal(h.flightState.records.missingPolls.has(ICAO), false);
  } finally {
    h.restore();
  }
});

test('military: a stalled feed dims the tracked plane as STALE', () => {
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
    assert.equal(h.tracking._trackedIconColor().alpha, STALE_ALPHA);
    assert.equal(h.flightState.records.missingPolls.has(ICAO), false);
  } finally {
    h.restore();
  }
});

test('military: a report arriving after the plane has stopped: it eases in with no spur, and the trail keeps everything up to the stop', () => {
  const { fixes, info } = outOfCoverage();
  info.lastContactEpochMs = fixes.at(-1).epochMs;
  const h = harness({ fixes, info, nowMs: pastReport(-5) });
  try {
    h.tracking._startTrail(ICAO);
    h.run(pastReport(360));
    const stop = Cesium.Cartesian3.clone(h.drawn.at(-1));
    assert.ok(Cesium.Cartesian3.distance(stop, h.drawn.at(-100)) < 0.01);
    const kept = h.flightState._trailFixes
      .filter((e) => e.drawn)
      .map((e) => Cesium.Cartesian3.clone(e.position));
    // The thinned straight coast, recorded up to where the plane stopped.
    assert.ok(kept.length >= 2);
    assert.ok(Cesium.Cartesian3.distance(kept.at(-1), stop) < 300);
    // Heard again, for 20 s before the display time: the plane flew on, a
    // little north of its old heading.
    const at = T0 + 30 * SEC + 340 * SEC;
    const lonDeg =
      -108.05 + (140 * 340) / (111_320 * Math.cos((43 * Math.PI) / 180));
    const report = fix(at, 43 + 1_000 / 111_320, lonDeg, 6_400, 140, 90);
    fixes.push(report);
    h.tracking._appendTrailFix(
      Cesium.Cartesian3.clone(report.position),
      report.epochMs,
    );
    // Nothing was recorded after the stop, so nothing is dropped.
    const after = h.flightState._trailFixes
      .filter((e) => e.drawn)
      .map((e) => e.position);
    assert.equal(after.length, kept.length);
    kept.forEach((p, i) =>
      assert.ok(Cesium.Cartesian3.distance(p, after[i]) < 0.01),
    );
    const from = h.drawn.length;
    h.run(pastReport(365));
    const eased = h.drawn.slice(from - 1);
    const jump = Cesium.Cartesian3.distance(eased[0], eased.at(-1));
    for (let i = 1; i < eased.length; i++)
      assert.ok(
        Cesium.Cartesian3.distance(eased[i], eased[i - 1]) < jump / 2,
        'the plane jumped instead of easing',
      );
    // On the path from the report: 25 s on from it at 140 m/s.
    const off = Cesium.Cartesian3.distance(eased.at(-1), report.position);
    assert.ok(Math.abs(off - 140 * 25) < 150, `${off.toFixed(0)} m`);
    assertNoSpur(h.bodyPoints(), 'trail');
    assertNoSpur(h.head(), 'head');
    assert.ok(indexOfPoint(h.bodyPoints(), report.position) >= 0);
  } finally {
    h.restore();
  }
});
