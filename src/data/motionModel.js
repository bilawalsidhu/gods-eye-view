// src/data/motionModel.js
/**
 * Pure display-motion math for the aircraft layers. No layer state, no DOM —
 * importable under `node --test`.
 *
 * Turn-rate estimation + constant-rate-turn arc integration are adapted from
 * skylight (https://github.com/cpaczek/skylight, MIT) shared/src/aim.ts.
 */
import * as Cesium from 'cesium';

const DEG = Math.PI / 180;
const _mmCarto = new Cesium.Cartographic();
const _mmCandidateCarto = new Cesium.Cartographic();

/**
 * Wrap a bearing into [0, 360).
 * @param {number} deg Angle in degrees; non-finite input propagates NaN.
 * @returns {number} Equivalent angle in [0, 360).
 */
export function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * Lift a repeated grounded fix to a newly resolved render floor without
 * manufacturing a new source timestamp or changing its reported lat/lon.
 * Airborne fixes and downward candidates are deliberately left untouched.
 *
 * @param {{position: Cesium.Cartesian3}|null} newest Fix to repair in place —
 *   its `position` Cartesian3 is rewritten, never replaced.
 * @param {Cesium.Cartesian3|null} candidatePosition The newly resolved render
 *   floor supplying the target height.
 * @param {boolean} onGround Whether the contact is currently grounded.
 * @returns {boolean} True when the stored position was lifted.
 */
export function liftRepeatedGroundFix(newest, candidatePosition, onGround) {
  if (!onGround || !newest?.position || !candidatePosition) return false;
  const stored = Cesium.Cartographic.fromCartesian(
    newest.position, Cesium.Ellipsoid.WGS84, _mmCarto,
  );
  const candidate = Cesium.Cartographic.fromCartesian(
    candidatePosition, Cesium.Ellipsoid.WGS84, _mmCandidateCarto,
  );
  if (!stored || !candidate || candidate.height <= stored.height) return false;
  Cesium.Cartesian3.fromRadians(
    stored.longitude,
    stored.latitude,
    candidate.height,
    Cesium.Ellipsoid.WGS84,
    newest.position,
  );
  return true;
}

/**
 * Normalize to (−180, 180].
 * @param {number} deg Angle in degrees.
 * @returns {number} Signed equivalent, used for shortest-arc deltas.
 */
export function norm180(deg) {
  const n = norm360(deg);
  return n > 180 ? n - 360 : n;
}

/**
 * Course over ground (deg from north, clockwise) of the chord from → to,
 * measured in `from`'s local ENU frame. Returns null when the chord is shorter
 * than `minChordM` or the motion is vertical-only (direction unreliable —
 * callers fall back to the reported track).
 *
 * @param {Cesium.Cartesian3} from Earlier fix.
 * @param {Cesium.Cartesian3} to Later fix.
 * @param {number} [minChordM] Minimum chord length in metres below which the
 *   direction is treated as unreadable.
 * @returns {?number} Course over ground in degrees, or null when the motion is
 *   too short or too vertical to measure.
 */
export function courseBetweenCartesians(from, to, minChordM = 25) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  if (dx * dx + dy * dy + dz * dz < minChordM * minChordM) return null;
  const carto = Cesium.Cartographic.fromCartesian(from, Cesium.Ellipsoid.WGS84, _mmCarto);
  if (!carto) return null;
  const sLat = Math.sin(carto.latitude);
  const cLat = Math.cos(carto.latitude);
  const sLon = Math.sin(carto.longitude);
  const cLon = Math.cos(carto.longitude);
  const e = -sLon * dx + cLon * dy;
  const n = -sLat * cLon * dx - sLat * sLon * dy + cLat * dz;
  if (e * e + n * n < 1) return null; // < 1 m horizontal — vertical-only motion
  return norm360(Math.atan2(e, n) / DEG);
}

// ---------------------------------------------------------------------------
// Low-speed course tuning (2026-07-03 field test: slow planes + helicopters).
// The interpolation chord is only trustworthy when the segment actually covers
// ground: at hover the fix-to-fix chord is a few metres of GPS jitter (its
// direction a pure random walk), and on a slow tight turn the chord STEPS by
// the whole per-segment turn at each poll boundary (a 60°/s whip, then frozen).
// Below the gate the reported per-fix track takes over; below the hold floor
// nothing is trustworthy and callers keep their previous display course.
// ---------------------------------------------------------------------------

/** At/below this displayed ground speed the course source is the reported
 *  track only (chord weight 0). ≈30 kt. */
export const COURSE_TRACK_ONLY_MPS = 15.4;
/** At/above this displayed ground speed the course source is the chord only
 *  (weight 1) — the field-validated regime; behavior is unchanged there.
 *  ≈50 kt. */
export const COURSE_CHORD_ONLY_MPS = 25.7;
/** Below this displayed speed neither chord nor reported track means anything
 *  (hover / GPS drift — a hovering heli's track is velocity-vector noise):
 *  callers HOLD their previous display course. ≈3 kt. */
export const COURSE_HOLD_SPEED_MPS = 1.5;
/** Course slew cap at/below the track-only gate. Slow aircraft turn a few °/s;
 *  whipping their nose at the fleet's 60°/s cap reads as a snap. */
export const COURSE_MIN_DPS = 12;
/** Below this fix ground speed, fix-track deltas are GPS-vector noise, not a
 *  turn — the turn-rate estimator ignores those intervals (a hovering heli's
 *  jitter used to manufacture a fake ±°/s rate that the extrapolation arc then
 *  integrated into a slow pirouette). ≈10 kt. */
export const TURN_MIN_SPEED_MPS = 5;

/** 0 at/below COURSE_TRACK_ONLY_MPS, 1 at/above COURSE_CHORD_ONLY_MPS, linear
 *  between. Non-finite speed (unknown) → 1, the legacy chord behavior. */
/**
 * 0 at/below COURSE_TRACK_ONLY_MPS, 1 at/above COURSE_CHORD_ONLY_MPS, linear
 *  between. Non-finite speed (unknown) → 1, the legacy chord behavior.
 * @param {number} speedMps Displayed ground speed in m/s.
 * @returns {number} Chord weight in [0, 1] used to blend chord course over the
 *   reported track.
 */
export function speedRamp(speedMps) {
  if (!Number.isFinite(speedMps)) return 1;
  if (speedMps <= COURSE_TRACK_ONLY_MPS) return 0;
  if (speedMps >= COURSE_CHORD_ONLY_MPS) return 1;
  return (speedMps - COURSE_TRACK_ONLY_MPS) / (COURSE_CHORD_ONLY_MPS - COURSE_TRACK_ONLY_MPS);
}

/** Shortest-arc angle lerp: from → to by t (t=0 → from, t=1 → to). Also the
 *  course blender (blend chord over track by the speed ramp). */
/**
 * Shortest-arc angle lerp: from → to by t (t=0 → from, t=1 → to). Also the
 *  course blender (blend chord over track by the speed ramp).
 * @param {number} fromDeg Start angle in degrees.
 * @param {number} toDeg End angle in degrees; taken the short way round.
 * @param {number} t Interpolation fraction; unclamped values extrapolate.
 * @returns {number} Interpolated angle wrapped into [0, 360).
 */
export function lerpAngleDeg(fromDeg, toDeg, t) {
  return norm360(fromDeg + norm180(toDeg - fromDeg) * t);
}

/** Speed-scaled slew cap for limitCourseStep: COURSE_MIN_DPS at low speed
 *  easing to `maxDps` at cruise, so slow aircraft glide through segment
 *  boundaries instead of whipping at the fleet cap. */
/**
 * Speed-scaled slew cap for limitCourseStep: COURSE_MIN_DPS at low speed
 *  easing to `maxDps` at cruise, so slow aircraft glide through segment
 *  boundaries instead of whipping at the fleet cap.
 * @param {number} speedMps Displayed ground speed in m/s.
 * @param {number} maxDps Cap reached at cruise speed.
 * @param {number} [minDps] Cap at/below the track-only gate.
 * @returns {number} Slew cap in deg/s for this speed.
 */
export function courseSlewCapDps(speedMps, maxDps, minDps = COURSE_MIN_DPS) {
  return minDps + (maxDps - minDps) * speedRamp(speedMps);
}

/**
 * Resolve the kinematics that belong to the position currently being drawn.
 *
 * A feed may transiently report zero or missing ground speed while consecutive
 * fixes still describe clear movement. The delayed renderer already derives a
 * matching segment speed and course from those fixes, so tracking and cockpit
 * consumers should prefer that pair over stale poll fields.
 *
 * @param {object} root0 Kinematics from the two sources that can describe one
 *   instant — the fix-derived segment and the feed's own poll fields.
 * @param {number} root0.derivedSpeedMps Speed computed from consecutive fixes.
 * @param {number} root0.derivedTrackDeg Course computed from consecutive fixes.
 * @param {number} root0.reportedSpeedMps Ground speed as reported by the feed.
 * @param {number} root0.reportedTrackDeg Track as reported by the feed.
 * @returns {{speedMps: ?number, trackDeg: ?number}} The derived pair where it is
 *   finite, otherwise the reported pair, otherwise null per field.
 */
export function displayedKinematics({
  derivedSpeedMps,
  derivedTrackDeg,
  reportedSpeedMps,
  reportedTrackDeg,
} = {}) {
  return {
    speedMps: Number.isFinite(derivedSpeedMps) ? Math.max(0, derivedSpeedMps)
      : (Number.isFinite(reportedSpeedMps) ? Math.max(0, reportedSpeedMps) : null),
    trackDeg: Number.isFinite(derivedTrackDeg) ? derivedTrackDeg
      : (Number.isFinite(reportedTrackDeg) ? reportedTrackDeg : null),
  };
}

/**
 * Bound forward coasting by the freshest source contact, not only by the last
 * position-fix epoch.
 *
 * ADS-B state vectors often keep receiving velocity/track messages after the
 * last position timestamp. A fixed "60 s after position" ceiling therefore
 * alternates between a frozen icon and a catch-up jump even while the source
 * still hears the aircraft. This horizon permits one grace window after the
 * latest actual contact, while `maximumSec` prevents a cached/stale feed from
 * drifting an aircraft indefinitely.
 *
 * @param {object} root0 The two source clocks plus the caller's bounds.
 * @param {number} root0.fixEpochMs Epoch ms of the newest position fix.
 * @param {number} root0.lastContactEpochMs Epoch ms of the newest message of
 *   ANY kind heard from the aircraft.
 * @param {number} [root0.minimumSec] Floor; also the answer for unusable clocks.
 * @param {number} [root0.contactGraceSec] Extra coast allowed past the last contact.
 * @param {number} [root0.maximumSec] Hard ceiling, regardless of contact lead.
 * @returns {number} Coast horizon in seconds, always within [minimumSec,
 *   maximumSec] so a caller can never be handed an unbounded coast.
 */
export function staleCoastLimitSeconds({
  fixEpochMs,
  lastContactEpochMs,
  minimumSec = 60,
  contactGraceSec = 60,
  maximumSec = 300,
} = {}) {
  const floor = Math.max(0, Number.isFinite(minimumSec) ? minimumSec : 60);
  const ceiling = Math.max(floor, Number.isFinite(maximumSec) ? maximumSec : 300);
  if (!Number.isFinite(fixEpochMs) || !Number.isFinite(lastContactEpochMs)) return floor;
  const contactLeadSec = Math.max(0, (lastContactEpochMs - fixEpochMs) / 1000);
  const grace = Math.max(0, Number.isFinite(contactGraceSec) ? contactGraceSec : 60);
  return Math.min(ceiling, Math.max(floor, contactLeadSec + grace));
}

/**
 * Shortest-arc rate limiter: step `prevDeg` toward `targetDeg` by at most
 * `maxDegPerSec * dtSec`. Seeds directly on the target when prev is null.
 * Smooths the once-per-fix course step at interpolation-segment boundaries
 * without lagging real turns (real aircraft turn ≤ ~4°/s; limiter default 60°/s).
 */
/**
 * Shortest-arc rate limiter: step `prevDeg` toward `targetDeg` by at most
 * `maxDegPerSec * dtSec`. Seeds directly on the target when prev is null.
 * Smooths the once-per-fix course step at interpolation-segment boundaries
 * without lagging real turns (real aircraft turn ≤ ~4°/s; limiter default 60°/s).
 *
 * @param {?number} prevDeg Previous displayed course; null/NaN seeds on target.
 * @param {number} targetDeg Course to converge on.
 * @param {number} maxDegPerSec Slew cap in deg/s.
 * @param {number} dtSec Elapsed seconds; negative is clamped to a zero step.
 * @returns {number} New displayed course in [0, 360).
 */
export function limitCourseStep(prevDeg, targetDeg, maxDegPerSec, dtSec) {
  if (prevDeg == null || !Number.isFinite(prevDeg)) return norm360(targetDeg);
  const d = norm180(targetDeg - prevDeg);
  const maxStep = Math.max(0, maxDegPerSec * Math.max(0, dtSec));
  const step = Math.abs(d) <= maxStep ? d : Math.sign(d) * maxStep;
  return norm360(prevDeg + step);
}

/**
 * Turn-rate estimate (deg/s) from track samples, with angle unwrapping.
 * Below `noiseFloorDps` returns 0 (treat as straight); clamped to ±maxDps
 * (standard-rate turn is 3°/s). dt sanity window matches our 15–30 s poll
 * cadence (2..120 s). When `minSpeedMps` > 0, intervals whose endpoints carry
 * a FINITE speed below it are skipped — at hover/taxi speed the reported track
 * is GPS-vector noise, not a turn (samples without a speed keep the legacy
 * behavior: no way to tell, so they still count).
 *
 * @param {Array<{tSec: number, trackDeg: number, speedMps?: number}>} samples
 *   Chronological track samples; fewer than two returns 0.
 * @param {number} [noiseFloorDps] Magnitude below which the estimate reads as
 *   straight flight and returns 0.
 * @param {number} [maxDps] Output clamp magnitude.
 * @param {number} [minSpeedMps] Skip intervals whose endpoint speeds are finite
 *   but below this.
 * @returns {number} Mean per-interval turn rate in deg/s, signed by turn
 *   direction, clamped to ±maxDps.
 */
export function estimateTurnRateDps(samples, noiseFloorDps = 0.4, maxDps = 4, minSpeedMps = 0) {
  if (!samples || samples.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].tSec - samples[i - 1].tSec;
    if (dt < 2 || dt > 120) continue;
    if (!Number.isFinite(samples[i].trackDeg) || !Number.isFinite(samples[i - 1].trackDeg)) continue;
    if (minSpeedMps > 0) {
      const v0 = samples[i - 1].speedMps;
      const v1 = samples[i].speedMps;
      if ((Number.isFinite(v0) && v0 < minSpeedMps) || (Number.isFinite(v1) && v1 < minSpeedMps)) continue;
    }
    sum += norm180(samples[i].trackDeg - samples[i - 1].trackDeg) / dt;
    n += 1;
  }
  if (!n) return 0;
  const rate = sum / n;
  if (Math.abs(rate) < noiseFloorDps) return 0;
  return Math.max(-maxDps, Math.min(maxDps, rate));
}

/** Adapter: fix history [{time: JulianDate, track, velocity}] →
 *  estimateTurnRateDps, guarded by TURN_MIN_SPEED_MPS (low-speed fix-track
 *  jitter must not manufacture a turn rate).
 *
 * @param {Array<{time: Cesium.JulianDate, track: number, velocity?: number}>}
 *   history Chronological fix history; times are differenced against the first
 *   entry, so absolute epochs do not matter.
 * @returns {number} Turn rate in deg/s, 0 when fewer than two usable fixes.
 */
export function turnRateFromFixHistory(history) {
  if (!history || history.length < 2) return 0;
  const t0 = history[0].time;
  const samples = [];
  for (const s of history) {
    if (!Number.isFinite(s.track)) continue;
    samples.push({
      tSec: Cesium.JulianDate.secondsDifference(s.time, t0),
      trackDeg: s.track,
      speedMps: s.velocity,
    });
  }
  return estimateTurnRateDps(samples, undefined, undefined, TURN_MIN_SPEED_MPS);
}

/** @constant {number} Metres per degree of latitude (spherical approximation). */
const METRES_PER_DEG = 111320;
/** @constant {number} Ground distance between samples along a projected arc
 *  (m). Half a coarse floor cell: the corridor's cell walk joins consecutive
 *  samples with a straight chord, and at this spacing the chord's departure
 *  from the arc is centimetres even on a tight taxi turn. A FIXED sample count
 *  cannot promise that — its spacing grows with speed, so a fast contact's
 *  chords cut corners off its own path. */
export const CORRIDOR_SAMPLE_SPACING_M = 55;
/** @constant {number} Longest arc a single corridor projects (m). The cell
 *  budget truncates at ~12 cells ≈ 1.3 km anyway, so projecting further just
 *  builds samples the walk will discard. Ground past this is picked up on a
 *  later poll as the display advances into it — the same honest truncation the
 *  straight walk makes. */
export const CORRIDOR_MAX_LENGTH_M = 1300;
/** Scratch for the shared arc integrator (see arcOffsetEnu). */
const _scratchProjectArc = { east: 0, north: 0, endCourseDeg: 0 };

/**
 * Where a ground contact will be after `dtSec`, using the SAME kinematics the
 * dead-reckon uses: `arcOffsetEnu`, which integrates a constant-rate turn
 * rather than running a straight tangent. A taxiing contact in a sustained
 * turn leaves the tangent within a few hundred metres, so a straight
 * projection would aim the display-floor corridor at ground it never crosses
 * while its actual arc stays cold.
 *
 * Flat-earth ENU→lat/lon on purpose: the only consumer quantises the result to
 * ~111 m cells over ≤1 km legs, where the spherical error is centimetres. The
 * TURN, not the earth model, is what mattered.
 *
 * @param {number} lat - Start latitude, degrees.
 * @param {number} lon - Start longitude, degrees.
 * @param {number} courseDeg - Instantaneous course (0 = north, 90 = east).
 * @param {number} speedMps - Ground speed.
 * @param {number} turnRateDps - Signed turn rate; 0 gives a straight leg.
 * @param {number} dtSec - Seconds ahead; 0 or negative returns the start.
 * @returns {{lat: number, lon: number}} Projected coordinate, degrees.
 */
export function projectGroundArcLatLon(lat, lon, courseDeg, speedMps, turnRateDps, dtSec) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat, lon };
  if (!Number.isFinite(courseDeg) || !Number.isFinite(speedMps) || !Number.isFinite(dtSec)
    || speedMps <= 0 || dtSec <= 0) {
    return { lat, lon };
  }
  const off = arcOffsetEnu(speedMps, courseDeg, turnRateDps || 0, dtSec, _scratchProjectArc);
  // Guard the pole: cos(lat) → 0 would send the longitude to infinity.
  const cosLat = Math.max(Math.cos(lat * DEG), 1e-6);
  return {
    lat: lat + off.north / METRES_PER_DEG,
    lon: lon + off.east / (METRES_PER_DEG * cosLat),
  };
}

/**
 * The PATH a grounded contact's display is about to walk — the ground its floor
 * needs to be warm for, as a polyline rather than a single endpoint.
 *
 * Two regimes, matching what the dead-reckon actually does:
 *  - INTERPOLATING: the display LERPS a straight chord between two fixes, so a
 *    two-point corridor to the newest fix is exact.
 *  - EXTRAPOLATING (coasting past the newest fix, or the pre-history warm-up):
 *    the display integrates a constant-rate turn away from that fix. A single
 *    projected endpoint would still be joined to the start by a straight chord,
 *    so a sustained turn's arc — where the contact actually goes — would be
 *    left cold. Sampling the arc keeps corridor and display on one path.
 *
 * @param {object} p - Display state for one grounded contact at one render tick.
 * @param {boolean} p.extrapolating - Whether the display position was extrapolated.
 * @param {number} p.displayLat - Where it renders now, latitude.
 * @param {number} p.displayLon - Where it renders now, longitude.
 * @param {number} p.courseDeg - Course of the displayed motion.
 * @param {number} p.speedMps - Displayed ground speed.
 * @param {number} [p.turnRateDps] - The contact's estimated turn rate.
 * @param {number} p.fixLat - The newest fix, latitude.
 * @param {number} p.fixLon - The newest fix, longitude.
 * @param {number} p.lookaheadSec - How far ahead to project when extrapolating.
 * The sample COUNT derives from the arc's length so spacing stays at
 * CORRIDOR_SAMPLE_SPACING_M whatever the speed, and the arc is truncated at
 * CORRIDOR_MAX_LENGTH_M rather than thinned — the same discipline the straight
 * walk uses. A fixed count silently widened its spacing as speed rose, and the
 * chords between widely spaced samples cut corners off the contact's own path,
 * leaving cells it genuinely occupies cold.
 *
 * @returns {Array<{lat: number, lon: number}>} Polyline, display position first.
 */
export function corridorPathLatLon({
  extrapolating, displayLat, displayLon, courseDeg, speedMps, turnRateDps = 0,
  fixLat, fixLon, lookaheadSec,
}) {
  if (!Number.isFinite(displayLat) || !Number.isFinite(displayLon)) return [];
  const start = { lat: displayLat, lon: displayLon };
  if (!extrapolating && Number.isFinite(fixLat) && Number.isFinite(fixLon)) {
    // The dead-reckon LERPS a straight chord between two fixes, so two points
    // ARE the display path here; the corridor's own walk fills the cells.
    return [start, { lat: fixLat, lon: fixLon }];
  }
  const speed = Number.isFinite(speedMps) ? speedMps : 0;
  const seconds = Number.isFinite(lookaheadSec) ? lookaheadSec : 0;
  if (speed <= 0 || seconds <= 0) return [start];
  const cappedSec = Math.min(seconds, CORRIDOR_MAX_LENGTH_M / speed);
  const arcLengthM = speed * cappedSec;
  const n = Math.max(1, Math.ceil(arcLengthM / CORRIDOR_SAMPLE_SPACING_M));
  const out = [start];
  for (let i = 1; i <= n; i++) {
    out.push(projectGroundArcLatLon(
      displayLat, displayLon, courseDeg, speed, turnRateDps, cappedSec * (i / n),
    ));
  }
  return out;
}

/**
 * Dead-reckon offset in the local ENU frame: along-track at ground speed,
 * integrating a constant-rate turn when turnRateDps is significant. Writes
 * {east, north, endCourseDeg} into `result` (no allocation) and returns it.
 * Works for negative dt (backward extrapolation — the warm-up path).
 *
 * @param {number} speedMps Ground speed in m/s.
 * @param {number} trackDeg Instantaneous course, degrees from north.
 * @param {number} turnRateDps Signed turn rate; |rate| below ~0.006 deg/s
 *   degenerates to the straight tangent.
 * @param {number} dtSec Seconds to integrate; negative steps backwards.
 * @param {{east: number, north: number, endCourseDeg: number}} result Scratch
 *   object written in place.
 * @returns {{east: number, north: number, endCourseDeg: number}} The same
 *   `result`: ENU offset in metres plus the course at the end of the arc.
 */
export function arcOffsetEnu(speedMps, trackDeg, turnRateDps, dtSec, result) {
  const tr = trackDeg * DEG;
  const w = (turnRateDps || 0) * DEG; // rad/s
  if (Math.abs(w) < 1e-4) {
    result.east = speedMps * Math.sin(tr) * dtSec;
    result.north = speedMps * Math.cos(tr) * dtSec;
    result.endCourseDeg = norm360(trackDeg);
    return result;
  }
  result.east = (speedMps / w) * (Math.cos(tr) - Math.cos(tr + w * dtSec));
  result.north = (speedMps / w) * (Math.sin(tr + w * dtSec) - Math.sin(tr));
  result.endCourseDeg = norm360(trackDeg + turnRateDps * dtSec);
  return result;
}

const _forwardFixArc = { east: 0, north: 0, endCourseDeg: 0 };
const _forwardFixEnu = new Cesium.Matrix4();
const _forwardFixOffset = new Cesium.Cartesian3();

/**
 * Create a forward-only synthetic fix when a repeated position epoch carries
 * newer velocity or course data. The prior fix remains immutable: its own
 * kinematics project it to `epochMs`, and only the returned fix adopts the new
 * kinematics. This prevents a late course change from reprojecting the entire
 * stale interval and snapping the rendered contact by kilometres.
 *
 * @param {{time: Cesium.JulianDate, epochMs?: number, position: Cesium.Cartesian3,
 *   velocity?: number, track?: number}} newest Existing immutable history fix.
 * @param {{epochMs: number, velocity: number, track: number, turnRateDps?: number}} next
 *   New kinematics and the wall/source epoch at which they become authoritative.
 * @returns {{time: Cesium.JulianDate, epochMs: number, position: Cesium.Cartesian3,
 *   velocity: number, track: number}|null} Forward synthetic fix, or null.
 */
export function synthesizeForwardKinematicsFix(newest, next = {}) {
  if (!newest?.position || !newest?.time || !Number.isFinite(next.epochMs)) return null;
  const startEpochMs = Number.isFinite(newest.epochMs)
    ? newest.epochMs
    : Cesium.JulianDate.toDate(newest.time).getTime();
  if (!Number.isFinite(startEpochMs) || next.epochMs <= startEpochMs) return null;

  const previousVelocity = Number.isFinite(newest.velocity) ? Math.max(0, newest.velocity) : 0;
  const previousTrack = Number.isFinite(newest.track) ? newest.track : 0;
  const dtSec = (next.epochMs - startEpochMs) / 1000;
  arcOffsetEnu(
    previousVelocity,
    previousTrack,
    Number.isFinite(next.turnRateDps) ? next.turnRateDps : 0,
    dtSec,
    _forwardFixArc,
  );
  Cesium.Cartesian3.fromElements(
    _forwardFixArc.east,
    _forwardFixArc.north,
    0,
    _forwardFixOffset,
  );
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
    newest.position,
    Cesium.Ellipsoid.WGS84,
    _forwardFixEnu,
  );
  const position = Cesium.Matrix4.multiplyByPoint(
    enu,
    _forwardFixOffset,
    new Cesium.Cartesian3(),
  );
  return {
    time: Cesium.JulianDate.fromDate(new Date(next.epochMs)),
    epochMs: next.epochMs,
    position,
    velocity: Number.isFinite(next.velocity) ? Math.max(0, next.velocity) : previousVelocity,
    track: Number.isFinite(next.track) ? next.track : previousTrack,
  };
}
