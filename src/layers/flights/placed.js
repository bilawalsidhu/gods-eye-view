import { fromDegreesInto, toCartographicRadians } from '../../geo/ellipsoid.js';
import { COURSE_HOLD_SPEED_MPS } from '../../data/motionModel.js';
import { followsClock } from './policy.js';

/**
 * Where the host-supplied placement (`services.placement`,
 * ../../data/placementProvider.js) draws an aircraft at `wallMs`, written
 * into `out`, with the course and speed it is drawn with; null when it has
 * no answer for this aircraft. A placement without a height keeps the
 * aircraft's newest drawn height, and one without a course or speed the
 * record's own.
 * @param {object} placement
 * @param {string} icao24
 * @param {number} wallMs
 * @param {object|undefined} info The aircraft's record.
 * @param {{position: {x: number, y: number, z: number}}[]} history Its fixes, newest last.
 * @param {{x: number, y: number, z: number}} out
 * @returns {{courseDeg: number, speedMps: number, extrapolating: boolean}|null}
 */
export function placeAircraftAt(placement, icao24, wallMs, info, history, out) {
  const placed = placement.place(icao24, wallMs);
  if (!placed) return null;
  let heightM = placed.altitudeM;
  if (!Number.isFinite(heightM)) heightM = info?.renderAltitudeM;
  if (!Number.isFinite(heightM))
    heightM =
      toCartographicRadians(history[history.length - 1].position)?.height ?? 0;
  const speedMps = Number.isFinite(placed.speedMps)
    ? placed.speedMps
    : // Civil records carry velocity and true_track, military speedMps and track.
      Number.isFinite(info?.velocity)
      ? info.velocity
      : info?.speedMps || 0;
  const courseDeg = Number.isFinite(placed.courseDeg)
    ? placed.courseDeg
    : Number.isFinite(info?.true_track)
      ? info.true_track
      : info?.track || 0;
  fromDegreesInto(placed.lon, placed.lat, heightM, out);
  return { courseDeg, speedMps, extrapolating: placed.extrapolating };
}

/**
 * Where the host-supplied placement draws a live aircraft now, written into
 * `out` with the course scratches `_deadReckon` sets on `flightState`; false
 * when there is no placement, the layer follows the world clock, or it has
 * no answer for this aircraft, and the layer's own motion places it.
 * @param {object} flightState The civil or military flight state.
 * @param {object|null|undefined} placement
 * @param {string} icao24
 * @param {object|undefined} info The aircraft's record.
 * @param {{position: {x: number, y: number, z: number}}[]} history Its fixes, newest last.
 * @param {{x: number, y: number, z: number}} out
 * @returns {boolean}
 */
export function placeLiveAircraft(
  flightState,
  placement,
  icao24,
  info,
  history,
  out,
) {
  flightState._drSpeedPlaced = false;
  if (!placement || followsClock(flightState)) return false;
  const placed = placeAircraftAt(
    placement,
    icao24,
    flightState.now(),
    info,
    history,
    out,
  );
  if (!placed) return false;
  flightState._drCourseDeg = placed.courseDeg;
  flightState._drSpeedMps = placed.speedMps;
  flightState._drSpeedPlaced = true;
  flightState._drCourseHold = placed.speedMps < COURSE_HOLD_SPEED_MPS;
  flightState._drExtrapolating = placed.extrapolating;
  return true;
}

/**
 * Tell the host-supplied placement, if any, that the aircraft `ids` left the
 * layer (removed, the layer off, or the world clock moved it to another time).
 * @param {object|null|undefined} placement
 * @param {Iterable<string>} ids
 */
export function forgetPlacedAircraft(placement, ids) {
  if (!placement) return;
  for (const id of ids) placement.forget(id);
}

/**
 * Tell the host-supplied placement an aircraft's fix as the layer took it
 * (nothing while the layer follows the world clock): its own time, its
 * position, the height the layer draws it at (NaN when that height is
 * invented), the ground under it in that height's reference (NaN where the
 * layer does not know it), and its reported speed, course and ground state.
 * @param {object} flightState
 * @param {object|null|undefined} placement
 * @param {string} icao24
 * @param {number} fixEpochMs
 * @param {{rawLat: number, rawLon: number, renderAltitudeM: number,
 *   renderAltitudeInvented?: boolean, groundM?: number|null,
 *   onGround?: boolean}} meta
 * @param {number|null|undefined} speedMps
 * @param {number|null|undefined} courseDeg
 */
export function observeLiveAircraft(
  flightState,
  placement,
  icao24,
  fixEpochMs,
  meta,
  speedMps,
  courseDeg,
) {
  if (!placement || followsClock(flightState)) return;
  placement.observe(icao24, {
    timeMs: fixEpochMs,
    lat: meta.rawLat,
    lon: meta.rawLon,
    altitudeM:
      meta.renderAltitudeInvented === true ? NaN : meta.renderAltitudeM,
    groundM: Number.isFinite(meta.groundM) ? meta.groundM : NaN,
    speedMps: Number.isFinite(speedMps) ? speedMps : NaN,
    courseDeg: Number.isFinite(courseDeg) ? courseDeg : NaN,
    headingDeg: NaN,
    onGround: meta.onGround === true,
  });
}
