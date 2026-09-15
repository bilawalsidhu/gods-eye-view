/** Transit admission and orientation policy; storage and clocks are portable. */
import {
  createTrack,
  createSample,
  insertFix,
  advance,
  readFix,
  correctHeight,
  setTimeOffsetMs,
} from '../../data/contactPlayback.js';
export const FIX_HISTORY_MAX = 128;
export const DISPLAY_LAG_MIN_MS = 25_000;
export const DISPLAY_LAG_RESET_MS = 90_000;
export const MODE_MAX_SPEED_MPS = Object.freeze({
  bus: 36, // ~130 km/h — a coach on a motorway
  tram: 28, // ~100 km/h — interurban light rail
  subway: 42, // ~150 km/h
  rail: 111, // ~400 km/h — high-speed services exist on some feeds
  ferry: 25, // ~90 km/h — fast catamarans
  unknown: 56, // ~200 km/h
});

/**
 * The ceiling a fix is judged against. A mode a feed DEFAULTED to is a guess
 * about a fleet, not a fact about a vehicle: TransLink publishes rail in a
 * feed whose default is bus, and a bus ceiling refused its 140 km/h services
 * as impossible and placed them instead of animating them. An inferred mode
 * gets the permissive ceiling; only a mode the route id actually established
 * gets its own.
 * @param {string} mode
 * @param {boolean} [inferred] Whether the mode came from a feed default.
 * @returns {number} m/s
 */
export function speedCeilingMps(mode, inferred = false) {
  if (inferred) return MODE_MAX_SPEED_MPS.unknown;
  return MODE_MAX_SPEED_MPS[mode] ?? MODE_MAX_SPEED_MPS.unknown;
}

/** Position deadband is disabled: even a short reported crawl is played. */
export const FIX_NOISE_M = 0;

/**
 * Displacement (m) a glide must cover before its direction is worth believing.
 * Below this the course derived from it is noise; the last good one is held.
 */
export const COURSE_MIN_TRAVEL_M = 12;

/** Maximum display-course change per second (deg). A bus is not a gyroscope. */
export const COURSE_MAX_RATE_DEG_PER_S = 120;
/**
 * Longest stretch of elapsed time (s) one evaluation may spend. The limiter
 * used to bank the time since the course last CHANGED, so a vehicle that held
 * north for thirty seconds had thirty seconds of allowance and snapped through
 * a corner in one step. Elapsed time is now measured since the course was last
 * EVALUATED, and capped here so that even a first look after a long idle
 * sweeps visibly instead of snapping.
 */
export const COURSE_STEP_MAX_S = 0.25;

/**
 * Consecutive fixes at the same place before a vehicle is called STOPPED.
 * One is not enough: a fifteen-second gap between identical fixes is also what
 * a vehicle waiting at a light looks like, and so is a feed that repeated
 * itself.
 */
export const STOPPED_FIXES = 2;

/**
 * How long after its newest fix a vehicle stops being described as travelling.
 *
 * "En route" means the last two fixes are in different places, which is a fact
 * about the past. A bus that reported movement and then went quiet for three
 * minutes is not en route — we simply do not know what it is doing, and saying
 * otherwise is the same overreach as reading STOPPED off a stale status. Ninety
 * seconds matches the threshold at which a whole feed reads as gone quiet.
 */
export const MOTION_UNKNOWN_AFTER_MS = 90_000;

const EARTH_M_PER_DEG = 111_320;

/**
 * Metres between two lat/lon points, flat-earth. Over the few hundred metres a
 * surface vehicle covers between fixes this is exact to well under a metre.
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 * @returns {number}
 */
export function fixDistanceM(a, b) {
  if (!a || !b) return 0;
  const dLat = (b.lat - a.lat) * EARTH_M_PER_DEG;
  const dLon =
    (b.lon - a.lon) * EARTH_M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * Course in degrees clockwise from north, from one point to another.
 * @param {{lat:number, lon:number}} from
 * @param {{lat:number, lon:number}} to
 * @returns {number} 0-360
 */
export function courseBetween(from, to) {
  const dLat = (to.lat - from.lat) * EARTH_M_PER_DEG;
  const dLon =
    (to.lon - from.lon) *
    EARTH_M_PER_DEG *
    Math.cos((from.lat * Math.PI) / 180);
  const deg = (Math.atan2(dLon, dLat) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Shortest signed difference between two courses, in degrees (-180, 180].
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
export function courseDelta(from, to) {
  let delta = ((to - from + 540) % 360) - 180;
  if (delta === -180) delta = 180;
  return delta;
}

/**
 * Whether a displacement between two fixes could have been travelled.
 * @param {string} mode
 * @param {number} meters
 * @param {number} seconds
 * @param {boolean} [inferred] The mode is a feed default, not a route fact.
 * @returns {boolean} False when the implied speed is impossible for the mode.
 */
export function displacementPlausible(mode, meters, seconds, inferred = false) {
  if (!(meters > 0)) return true;
  const ceiling = speedCeilingMps(mode, inferred);
  // Below a second of separation the implied speed is dominated by clock
  // resolution, so judge those against a flat displacement instead.
  if (!(seconds >= 1)) return meters <= ceiling;
  return meters / seconds <= ceiling;
}

export function initializePlayback(entry, budget, feedLag) {
  entry.track = createTrack({
    budget,
    policy: {
      feedLag,
      courseMinTravelM: COURSE_MIN_TRAVEL_M,
      staleMs: MOTION_UNKNOWN_AFTER_MS,
      accept: (a, b) =>
        displacementPlausible(
          entry.mode,
          fixDistanceM(a, b),
          (b.t - a.t) / 1000,
          entry.modeInferred,
        ),
    },
  });
  entry.sample = createSample();
  entry.segment = { from: {}, to: {}, fraction: NaN };
  entry.clocks = { wallNowMs: NaN, monoNowMs: NaN };
  // Inspection only. Scene animation reads the typed store into owned scratch.
  Object.defineProperty(entry, 'playT', {
    configurable: true,
    get: () => entry.sample.displayT,
  });
  Object.defineProperty(entry, 'lagTarget', {
    configurable: true,
    get: () => entry.track.targetDelayMs,
  });
  Object.defineProperty(entry, 'fixes', {
    configurable: true,
    get() {
      return Array.from({ length: entry.track.count }, (_, i) =>
        readFix(entry.track, i),
      );
    },
  });
}
export function recordFix(entry, fix, observation = {}) {
  const context = observation.context;
  let epoch = entry.currentEpoch || 1;
  if (context) {
    const previous = entry.track.epochs.get(epoch);
    if (
      previous &&
      (previous.trip !== context.trip ||
        previous.route !== context.route ||
        previous.mode !== context.mode)
    )
      epoch = Math.max(0, ...entry.track.epochs.keys()) + 1;
  }
  const result = insertFix(entry.track, { ...fix, epoch }, observation);
  if (result.accepted) {
    const latest = readFix(
      entry.track,
      entry.track.count - 1,
      entry.track.latest,
    );
    entry.currentEpoch = latest.epoch;
    if (context) entry.track.epochs.set(latest.epoch, context);
  }
  return result;
}
export function updatePlayback(entry, wallNowMs, monoNowMs) {
  entry.clocks.wallNowMs = wallNowMs;
  entry.clocks.monoNowMs = monoNowMs;
  advance(entry.track, entry.clocks, entry.sample);
  entry.resets = entry.track.resets;
  const segment = entry.segment;
  readFix(
    entry.track,
    entry.sample.fromSeq - entry.track.baseSeq,
    segment.from,
  );
  readFix(entry.track, entry.sample.toSeq - entry.track.baseSeq, segment.to);
  segment.fraction = entry.sample.fraction;
  return entry.sample;
}
export function syncPlayback(entry, wallNowMs, monoNowMs = performance.now()) {
  entry.clocks.wallNowMs = wallNowMs;
  entry.clocks.monoNowMs = monoNowMs;
  const resets = entry.track.resets;
  const reason = entry.track.resetReason;
  setTimeOffsetMs(entry.track, 0, entry.clocks);
  if (entry.hasRendered) entry.track.resetReason = 're-entry';
  else {
    entry.track.resets = resets;
    entry.track.resetReason = reason;
  }
  updatePlayback(entry, wallNowMs, monoNowMs);
}
export function playbackPosition(entry) {
  if (!entry?.track) return null;
  return {
    lat: entry.sample.lat,
    lon: entry.sample.lon,
    settled: entry.sample.phase !== 'playing',
  };
}
export function attachFloorToPlace(entry, fix, heightM) {
  if (!entry.track || !Number.isFinite(heightM)) return;
  const scratch = {};
  for (let i = 0; i < entry.track.count; i++) {
    readFix(entry.track, i, scratch);
    if (scratch.lat === fix.lat && scratch.lon === fix.lon)
      correctHeight(entry.track, scratch.seq, heightM);
  }
}
export function displayCourse(entry, nowMs) {
  if (!entry) return null;
  const target = Number.isFinite(entry.sample?.segmentCourseDeg)
    ? entry.sample.segmentCourseDeg
    : null;
  if (target === null) return entry.courseDeg ?? null;
  if (entry.courseDeg === null || !Number.isFinite(entry.courseEvalAt)) {
    return target;
  }

  // Rate-limit, the way the aircraft display course does: a fix arriving from
  // around a corner should sweep, not snap. Time since the last EVALUATION,
  // capped, so idle time is never banked into one big turn.
  const elapsedS = Math.min(
    COURSE_STEP_MAX_S,
    Math.max(0, (nowMs - entry.courseEvalAt) / 1000),
  );
  const allowed = COURSE_MAX_RATE_DEG_PER_S * elapsedS;
  const delta = courseDelta(entry.courseDeg, target);
  if (Math.abs(delta) <= allowed) return target;
  return (entry.courseDeg + Math.sign(delta) * allowed + 360) % 360;
}

/**
 * Evaluate the display course and write it back — the ONE writer both the
 * poll and the rotation pass go through, so the limiter sees every look.
 * @param {object} entry
 * @param {number} nowMs
 * @returns {boolean} Whether the course changed.
 */
export function applyDisplayCourse(entry, nowMs) {
  const course = displayCourse(entry, nowMs);
  entry.courseEvalAt = nowMs;
  if (course === entry.courseDeg) return false;
  entry.courseDeg = course;
  entry.courseAt = nowMs;
  return true;
}

export function displayMotion(entry, nowMs) {
  if (!entry) return { moving: false, word: '' };
  const sample = entry.sample;
  if (!sample) return { moving: false, word: 'WAITING' };
  if (sample.latestReportAgeMs > MOTION_UNKNOWN_AFTER_MS)
    return { moving: false, word: 'NO FIX' };
  if (sample.phase !== 'playing') return { moving: false, word: 'WAITING' };
  if (sample.motion === 'stopped') return { moving: false, word: 'STOPPED' };
  return {
    moving: sample.motion === 'moving',
    word: sample.motion === 'moving' ? 'EN ROUTE' : 'WAITING',
  };
}
