import * as Cesium from 'cesium';
import { COURSE_HOLD_SPEED_MPS } from '../../data/motionModel.js';
import { followsClock } from './policy.js';

/** Scratch for a placed contact's held height. */
const _placedCarto = new Cesium.Cartographic();

/**
 * Where the host-supplied placement (`services.placement`,
 * ../../data/placementProvider.js) draws a live aircraft now, written into
 * `out` with the course scratches `_deadReckon` sets on `flightState`; false
 * when there is no placement, the layer follows the world clock, or it has
 * no answer for this aircraft, and the layer's own motion places it. A
 * placement without a height keeps the aircraft's newest drawn height.
 * @param {object} flightState The civil or military flight state.
 * @param {object|null|undefined} placement
 * @param {string} icao24
 * @param {object|undefined} info The aircraft's record.
 * @param {{position: Cesium.Cartesian3}[]} history Its fixes, newest last.
 * @param {Cesium.Cartesian3} out
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
  if (!placement || followsClock(flightState)) return false;
  const placed = placement.place(icao24, flightState.now());
  if (!placed) return false;
  let heightM = placed.altitudeM;
  if (!Number.isFinite(heightM)) heightM = info?.renderAltitudeM;
  if (!Number.isFinite(heightM))
    heightM = Cesium.Cartographic.fromCartesian(
      history[history.length - 1].position,
      Cesium.Ellipsoid.WGS84,
      _placedCarto,
    ).height;
  const speed = Number.isFinite(placed.speedMps)
    ? placed.speedMps
    : // Civil records carry velocity and true_track, military speedMps and track.
      Number.isFinite(info?.velocity)
      ? info.velocity
      : info?.speedMps || 0;
  flightState._drCourseDeg = Number.isFinite(placed.courseDeg)
    ? placed.courseDeg
    : Number.isFinite(info?.true_track)
      ? info.true_track
      : info?.track || 0;
  flightState._drSpeedMps = speed;
  flightState._drCourseHold = speed < COURSE_HOLD_SPEED_MPS;
  flightState._drExtrapolating = placed.extrapolating;
  Cesium.Cartesian3.fromDegrees(
    placed.lon,
    placed.lat,
    heightM,
    Cesium.Ellipsoid.WGS84,
    out,
  );
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
 * invented), and its reported speed, course and ground state.
 * @param {object} flightState
 * @param {object|null|undefined} placement
 * @param {string} icao24
 * @param {number} fixEpochMs
 * @param {{rawLat: number, rawLon: number, renderAltitudeM: number,
 *   renderAltitudeInvented?: boolean, onGround?: boolean}} meta
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
    speedMps: Number.isFinite(speedMps) ? speedMps : NaN,
    courseDeg: Number.isFinite(courseDeg) ? courseDeg : NaN,
    headingDeg: NaN,
    onGround: meta.onGround === true,
  });
}
