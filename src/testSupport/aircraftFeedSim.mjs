/**
 * A slow aircraft feed played through an aircraft layer's real ingestion,
 * motion, icon planning and tracked trail, frame by frame on a fake clock.
 *
 * The feed is shaped like the anonymous live feed as measured: each poll
 * (every 30 s) carries reports about 90 s old (p10 90.5 s, p50 91.5 s, p90
 * 94.5 s), now and then a contact whose report did not move on, and a spell
 * where a fallback feed with fresh reports stands in. Every contact flies one
 * known path, so where it is drawn, and its trail, can be judged against
 * where it really was.
 */
import * as Cesium from 'cesium';
import { bindRenderer } from '../render/rendererOf.js';
import { createStubRenderer } from '../render/stub/index.js';
import { createContactIcons } from '../data/aircraftIconLayer.js';
import { createFlightState as flightsState } from '../layers/flights/state.js';
import { createIcons as flightsIcons } from '../layers/flights/icons.js';
import { createMotion as flightsMotion } from '../layers/flights/motion.js';
import { createTracking as flightsTracking } from '../layers/flights/tracking.js';
import { createFlightSnapshotRenderer } from '../layers/flights/snapshotRenderer.js';
import { createFlightState as militaryState } from '../layers/military/state.js';
import { createIcons as militaryIcons } from '../layers/military/icons.js';
import { createMotion as militaryMotion } from '../layers/military/motion.js';
import { createTracking as militaryTracking } from '../layers/military/tracking.js';
import { createMilitarySnapshotRenderer } from '../layers/military/snapshotRenderer.js';

const flights = {
  createFlightState: flightsState,
  createIcons: flightsIcons,
  createMotion: flightsMotion,
  createTracking: flightsTracking,
  createSnapshotRenderer: createFlightSnapshotRenderer,
};
const military = {
  createFlightState: militaryState,
  createIcons: militaryIcons,
  createMotion: militaryMotion,
  createTracking: militaryTracking,
  createSnapshotRenderer: createMilitarySnapshotRenderer,
};

const SEC = 1000;
const DEG = Math.PI / 180;
const EARTH_M = 6_371_008.8;

/** A small deterministic generator, 0..1. */
export function random(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * An arriving jet, seconds from its start: straight, a right turn of 160°,
 * straight, a left turn of 90°, then straight on, at 130 m/s descending.
 * Each contact flies it from its own start point.
 * @returns {(tSec: number) => {lat: number, lon: number, heightM: number, trackDeg: number, speedMps: number}}
 */
export function arrivalPath({
  lat0 = 37.9,
  lon0 = -122.9,
  speedMps = 130,
} = {}) {
  const turns = [
    [150, 107, 1.5],
    [457, 90, -1],
  ];
  const turnRate = (t) => {
    for (const [start, length, rate] of turns)
      if (t >= start && t < start + length) return rate;
    return 0;
  };
  // Integrated at 0.1 s; positions in metres east and north of the start.
  const STEP = 0.1;
  const samples = [{ e: 0, n: 0, track: 120 }];
  for (let i = 1; i <= 2000 / STEP; i++) {
    const prev = samples[i - 1];
    const t = (i - 0.5) * STEP;
    const track = prev.track + turnRate(t) * STEP;
    const mid = (prev.track + track) / 2;
    samples.push({
      e: prev.e + speedMps * STEP * Math.sin(mid * DEG),
      n: prev.n + speedMps * STEP * Math.cos(mid * DEG),
      track,
    });
  }
  return (tSec) => {
    const x = Math.max(0, Math.min(samples.length - 1.001, tSec / STEP));
    const i = Math.floor(x);
    const f = x - i;
    const a = samples[i];
    const b = samples[i + 1];
    const e = a.e + (b.e - a.e) * f;
    const n = a.n + (b.n - a.n) * f;
    return {
      lat: lat0 + n / EARTH_M / DEG,
      lon: lon0 + e / (EARTH_M * Math.cos(lat0 * DEG)) / DEG,
      heightM: Math.max(400, 3000 - 1.5 * tSec),
      trackDeg: (((a.track + (b.track - a.track) * f) % 360) + 360) % 360,
      speedMps,
    };
  };
}

/** A report age as measured on the anonymous feed: 90..95 s, now and then more. */
function slowAgeMs(rand) {
  const u = rand();
  return Math.round((90 + 4.5 * u * u) * SEC);
}

/**
 * The polls: receipt times and, per contact, the report time each carries.
 * `fallback` lists poll indexes the fresh fallback feed answers (reports 1-3 s
 * old); `repeats` lists `[contactIndex, pollIndex]` pairs whose report did not
 * move on (the poll repeats the contact's previous report).
 */
export function slowFeedPolls({
  startMs,
  count,
  contacts,
  firstPollSec = 120,
  intervalSec = 30,
  fallback = [],
  repeats = [],
  seed = 7,
}) {
  const rand = random(seed);
  const fallbackPolls = new Set(fallback);
  const repeated = new Set(repeats.map(([c, p]) => `${c}:${p}`));
  const polls = [];
  const last = new Array(contacts).fill(null);
  for (let k = 0; k < count; k++) {
    const receiptMs =
      startMs +
      (firstPollSec + k * intervalSec) * SEC +
      Math.round(rand() * 800);
    const fresh = fallbackPolls.has(k);
    const reports = [];
    for (let c = 0; c < contacts; c++) {
      const ageMs = fresh
        ? Math.round((1 + 2 * rand()) * SEC)
        : slowAgeMs(rand);
      let timeMs = Math.floor((receiptMs - ageMs) / SEC) * SEC;
      if (repeated.has(`${c}:${k}`) && last[c] != null) timeMs = last[c];
      last[c] = timeMs;
      reports.push(timeMs);
    }
    polls.push({ receiptMs, fresh, reports });
  }
  return polls;
}

/** Any property is a no-op function unless given. */
function stub(overrides = {}) {
  return new Proxy(overrides, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

function services(trails) {
  return {
    picking: stub(),
    sprites: stub(),
    labels: stub(),
    meshFloor: stub(),
    context: stub(),
    render: stub(),
    recession: stub(),
    readout: stub(),
    camera: stub(),
    aircraftPresentation: stub({
      isTr3b: () => false,
      tr3bTypeLabel: (id, label) => label,
      tr3bConvertedIds: new Set(),
    }),
    focus: stub({
      focusPassIsNeeded: () => false,
      nearFarScalarValueAtDistance: () => 1,
    }),
    militaryRegistry: stub({
      isMilitaryIcao: () => false,
      isMilitaryLayerActive: () => false,
    }),
    groundSnap: { createGroundSnap: () => stub() },
    trails,
    geoid: { ensureGeoidReady: async () => {}, geoidHeight: () => 0 },
    groundFloor: stub({
      cachedGroundFloor: () => null,
      GROUND_FLOOR_LIFT_M: 0.5,
      stickyFloorCell: (lat, lon) => ({ lat, lon }),
      coarseFloorCoord: (lat, lon) => ({ lat, lon }),
      neighborFloorM: () => null,
      floorAltitudeM: (alt) => alt,
      corridorFloorCells: () => [],
      allocateCorridorCells: () => [],
    }),
  };
}

/**
 * Play `polls` through a layer and draw `frames` at `frameMs`.
 * @param {object} options
 * @param {'flights'|'military'} options.layer
 * @param {number} options.startMs When every contact starts its path.
 * @param {Array} options.polls From `slowFeedPolls`.
 * @param {number} options.untilMs When the run stops.
 * @param {number} [options.frameMs] Frame interval.
 * @param {number} [options.measureFromMs] Frames before this are not kept.
 * @param {boolean} [options.followsClock] The layer follows the world clock
 *   (the timeline) instead of drawing live.
 * @returns {{frames: Array<{nowMs: number, displayMs: number, fleet: object|null, tracked: object|null}>,
 *   body: () => object[][], head: () => object[], truth: Function, layer: object}}
 */
export function runAircraftFeedSim({
  layer = 'flights',
  startMs,
  polls,
  untilMs,
  frameMs = 1000 / 30,
  measureFromMs = -Infinity,
  contacts,
  followsClock = false,
  onFrame = null,
  reportedSpeedMps = null,
}) {
  const mod = layer === 'flights' ? flights : military;
  const truth = arrivalPath();
  // Each contact flies the same path from its own start: contact c starts
  // c km further south, so they never meet.
  const where = (c, tMs) => {
    const p = truth((tMs - startMs) / SEC);
    return { ...p, lat: p.lat - c * 0.01 };
  };
  let clock = polls[0].receiptMs - 1;
  const realDateNow = Date.now;
  Date.now = () => clock;
  let bodySegments = [];
  let headPositions = [];
  const trails = {
    createTrail: () => ({
      setSegments(segments) {
        bodySegments = segments.map((segment) => segment.slice());
      },
      setPositions(positions) {
        bodySegments = [positions.slice()];
      },
      setHead(positions) {
        headPositions = positions.slice();
      },
      setVisible() {},
      clear() {
        bodySegments = [];
      },
      destroy() {},
    }),
  };
  const svc = services(trails);
  const flightState = mod.createFlightState({
    services: svc,
    source: { label: 'Fixture aircraft' },
  });
  flightState.now = () => clock;
  if (followsClock) flightState.timeline = { active: () => true };
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  flightState._viewer = viewer;
  flightState._icons = createContactIcons();
  const parts = {
    rendering: stub({
      _modelOwnsVisual: () => false,
      _modelSpec: () => ({}),
      _iconKind: () => 'jet',
      _fleetBillboardScale: () => 1,
      _fleetBillboardColor: () => [1, 1, 1, 1],
      _modelRegimeActive: () => false,
      _groundSampleExclusions: () => ({ sets: [] }),
    }),
    queries: stub({
      _contactLabel: (id, info) => info?.callsign || id,
      _likelyLanded: () => false,
    }),
  };
  parts.icons = mod.createIcons({ flightState, services: svc, parts });
  parts.motion = mod.createMotion({
    flightState,
    services: svc,
    parts,
    layer: {},
  });
  parts.tracking = mod.createTracking({
    flightState,
    services: svc,
    parts,
    layer: {},
  });
  const tracking = new Proxy(parts.tracking, {
    get: (target, key) =>
      key === '_militaryLayerSuppresses'
        ? () => false
        : key in target
          ? target[key]
          : () => undefined,
  });
  const apply = mod.createSnapshotRenderer({
    flightState,
    records: flightState.records,
    militaryRegistry: svc.militaryRegistry,
    groundFloor: svc.groundFloor,
    rendering: parts.rendering,
    tracking,
    motion: parts.motion,
    icons: parts.icons,
    enrichment: stub(),
    queries: parts.queries,
  });

  const id = (c) => `a0${String(c).padStart(4, '0')}`;
  const TRACKED = id(0);
  const FLEET = id(1);
  flightState._trackedIcao = TRACKED;

  function observation(c, timeMs) {
    const p = where(c, timeMs);
    return {
      id: id(c),
      reference: id(c),
      callsign: `TST${c}`,
      latitude: p.lat,
      longitude: p.lon,
      baroAltitudeM: p.heightM,
      ellipsoidAltitudeM: p.heightM,
      onGround: false,
      // A feed may report a speed that is not how fast the contact flies
      // (stale, or 0 when it gave none).
      speedMps: reportedSpeedMps ?? p.speedMps,
      courseDeg: p.trackDeg,
      verticalRateMps: -1.5,
      positionTimeMs: timeMs,
      contactTimeMs: timeMs,
      category: 3,
    };
  }

  const frames = [];
  let nextPoll = 0;
  let lastTickMs = -Infinity;
  let started = false;
  renderer.frame.on('preRender', () => {
    if (clock < measureFromMs) return;
    const displayMs = parts.icons._displayMs();
    const fleet = flightState._icons.has(FLEET)
      ? flightState._icons.position(FLEET, displayMs)
      : null;
    const tracked = parts.motion._trackedDisplayPosition(TRACKED);
    frames.push({
      nowMs: clock,
      displayMs,
      fleet: fleet && Cesium.Cartesian3.clone(fleet),
      tracked: tracked && Cesium.Cartesian3.clone(tracked),
    });
    onFrame?.({
      clock,
      displayMs,
      bodySegments,
      headPositions,
      flightState,
      parts,
    });
  });
  try {
    while (clock < untilMs) {
      clock = Math.min(untilMs, clock + frameMs);
      while (nextPoll < polls.length && polls[nextPoll].receiptMs <= clock) {
        const poll = polls[nextPoll++];
        apply({
          observedAtMs: poll.receiptMs,
          source: poll.fresh ? 'fallback' : 'slow',
          complete: true,
          records: poll.reports.map((timeMs, c) => observation(c, timeMs)),
        });
        if (!started && flightState._positionHistory.has(TRACKED)) {
          started = true;
          parts.tracking._startTrail(TRACKED);
        }
      }
      // The fleet pass: the motion clock every frame, plans at 12 Hz.
      parts.icons._syncMotionClock?.();
      if (clock - lastTickMs >= 80) {
        lastTickMs = clock;
        parts.icons._replanExpired(parts.icons._displayMs());
      }
      renderer.frame.requestRender('sim');
      renderer.testing.tick();
    }
  } finally {
    Date.now = realDateNow;
  }
  return {
    frames,
    body: () => bodySegments,
    head: () => headPositions,
    where,
    flightState,
    parts,
    contacts,
  };
}

/** The true path of contact `c` between two times, as ECEF points 0.5 s apart. */
export function truePath(sim, c, fromMs, toMs) {
  const points = [];
  for (let t = fromMs; t <= toMs; t += 500) {
    const p = sim.where(c, t);
    points.push(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.heightM));
  }
  return points;
}

/** Distance from p to the nearest point of a polyline. */
export function distanceToPath(p, path) {
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

/**
 * Frame-to-frame movement of one drawn contact against how far it should
 * move: its true speed over the display time that passed. A jump moves more
 * than 1.5 times that; a stall less than a quarter of it.
 * @returns {{worstRatio: number, worstJumpM: number, jumps: number, stalls: number, longestStall: number, worstAtMs: number}}
 */
export function frameSteps(sim, frames, key, speedMps) {
  let worstRatio = 0;
  let worstJumpM = 0;
  let worstAtMs = NaN;
  let jumps = 0;
  let stalls = 0;
  let run = 0;
  let longestStall = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1][key];
    const b = frames[i][key];
    if (!a || !b) continue;
    const expected =
      (speedMps * (frames[i].displayMs - frames[i - 1].displayMs)) / SEC;
    if (!(expected > 0.5)) continue;
    const moved = Cesium.Cartesian3.distance(a, b);
    const ratio = moved / expected;
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstJumpM = moved;
      worstAtMs = frames[i].nowMs;
    }
    if (ratio > 1.5) jumps += 1;
    if (ratio < 0.25) {
      stalls += 1;
      run += 1;
      longestStall = Math.max(longestStall, run);
    } else run = 0;
  }
  return { worstRatio, worstJumpM, jumps, stalls, longestStall, worstAtMs };
}

/** How far the contact is drawn from where it really was at the display time. */
export function placementError(sim, frames, key, c) {
  let worst = 0;
  for (const frame of frames) {
    const p = frame[key];
    if (!p) continue;
    const t = sim.where(c, frame.displayMs);
    const real = Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.heightM);
    worst = Math.max(worst, Cesium.Cartesian3.distance(p, real));
  }
  return worst;
}
