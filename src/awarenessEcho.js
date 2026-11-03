/**
 * @module awarenessEcho
 * @description The Global Context sonar echo field. The awareness layer
 * publishes it while its range pulses run; the detection overlay reads it to
 * pulse the brackets of contacts a pulse front has just crossed. It holds no
 * awareness policy of its own: the publisher passes radius, pulse timing and
 * echo styling in, so the overlay never imports awareness internals.
 */
import * as Cesium from 'cesium';

/**
 * @typedef {object} AwarenessEchoField
 * @property {Cesium.Cartesian3} center Subject's ground point. The publisher
 *   may move it in place; it is read on every query.
 * @property {number} radiusM Range the pulses grow to.
 * @property {{count: number, periodMs: number, startFraction: number}} pulse
 * @property {{fadeMs: number, layerIds: string[]}} echo
 */

/** @type {AwarenessEchoField|null} */
let field = null;
let layerIds = new Set();
const groundScratch = new Cesium.Cartesian3();

/**
 * Start (or replace) the echo field.
 * @param {AwarenessEchoField} next
 * @returns {void}
 */
export function setAwarenessEchoField(next) {
  field = next;
  layerIds = new Set(next.echo.layerIds);
}

/** Stop all echoes. Safe when none were set. */
export function clearAwarenessEchoField() {
  field = null;
  layerIds = new Set();
}

/** @returns {AwarenessEchoField|null} The field the overlay styles from. */
export function getAwarenessEchoField() {
  return field;
}

/**
 * How lit a contact's echo is at `nowMs`: 1 the moment a pulse front reaches
 * its distance, fading as (1 - elapsed / `fadeMs`) squared, 0 otherwise. The
 * strongest pulse wins. A front that has wrapped back to the centre still
 * counts for the contact it last crossed, so rim contacts fade out instead of
 * cutting off.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @param {number} distanceM Contact's distance from the subject.
 * @param {number} radiusM Range the pulses grow to.
 * @param {{count: number, periodMs: number, startFraction: number}} pulse
 * @param {{fadeMs: number}} echo
 * @returns {number} 0 to 1.
 */
export function awarenessEchoStrength(nowMs, distanceM, radiusM, pulse, echo) {
  if (!Number.isFinite(distanceM) || distanceM < 0 || distanceM > radiusM)
    return 0;
  // The phase at which a pulse front sits at this distance.
  const touchPhase = Math.max(
    0,
    (distanceM / radiusM - pulse.startFraction) / (1 - pulse.startFraction),
  );
  let strength = 0;
  for (let index = 0; index < pulse.count; index++) {
    const cycle = nowMs / pulse.periodMs + index / pulse.count;
    let since = cycle - Math.floor(cycle) - touchPhase;
    // Rounding at the exact crossing must not read as a whole period ago.
    if (since < -1e-9) since += 1;
    else if (since < 0) since = 0;
    const elapsedMs = since * pulse.periodMs;
    if (elapsedMs < echo.fadeMs)
      strength = Math.max(strength, (1 - elapsedMs / echo.fadeMs) ** 2);
  }
  return strength;
}

/**
 * The echo for one contact of `layerId` at world `position`, or 0 when no
 * field is set or the layer does not echo. Distance is measured between
 * ground points, so an aircraft's altitude does not shift its echo.
 * @param {string} layerId Owning layer of the contact.
 * @param {Cesium.Cartesian3} position Contact's world position.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @returns {number} 0 to 1.
 */
export function awarenessEchoAt(layerId, position, nowMs) {
  if (!field || !position || !layerIds.has(layerId)) return 0;
  const ground = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(
    position,
    groundScratch,
  );
  if (!ground) return 0;
  return awarenessEchoStrength(
    nowMs,
    Cesium.Cartesian3.distance(field.center, ground),
    field.radiusM,
    field.pulse,
    field.echo,
  );
}
