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
 * @property {{count: number, periodMs: number, startFraction: number, fadeInFraction?: number}} pulse
 * @property {{fadeMs: number, layerIds: string[]}} echo
 * @property {(nowMs: number) => number} [level] How far the pulses are
 *   switched on, 0 to 1; echoes scale with it, so they rest with the pulses.
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
 * Whether any echo can light at `nowMs`: a field is set and its pulses are
 * running. The overlay checks this once per frame, so resting pulses cost no
 * per-contact work.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @returns {boolean}
 */
export function awarenessEchoActive(nowMs) {
  return Boolean(field) && (field.level?.(nowMs) ?? 1) > 0;
}

/**
 * How lit a contact's echo is at `nowMs`: 1 the moment a pulse front reaches
 * its distance, fading as (1 - elapsed / `fadeMs`) squared, 0 otherwise. The
 * strongest pulse wins. A front that has wrapped back to the centre still
 * counts for the contact it last crossed, so rim contacts fade out instead of
 * cutting off. Nothing nearer than the birth ring `startFraction` out echoes,
 * and within the pulse's `fadeInFraction` the echo is scaled down with it.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @param {number} distanceM Contact's distance from the subject.
 * @param {number} radiusM Range the pulses grow to.
 * @param {{count: number, periodMs: number, startFraction: number, fadeInFraction?: number}} pulse
 * @param {{fadeMs: number}} echo
 * @returns {number} 0 to 1.
 */
export function awarenessEchoStrength(nowMs, distanceM, radiusM, pulse, echo) {
  // Pulses are born `startFraction` out, so nothing nearer (the subject
  // itself, its wingmen) is ever crossed; without this it lit on every birth.
  if (
    !Number.isFinite(distanceM) ||
    distanceM < radiusM * pulse.startFraction ||
    distanceM > radiusM
  )
    return 0;
  // The phase at which a pulse front sits at this distance.
  const touchPhase =
    (distanceM / radiusM - pulse.startFraction) / (1 - pulse.startFraction);
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
  // A front still fading in over `fadeInFraction` of its travel echoes no
  // brighter than it shows.
  const fadeIn = pulse.fadeInFraction ?? 0;
  return fadeIn > 0 ? strength * Math.min(1, touchPhase / fadeIn) : strength;
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
  const level = field.level?.(nowMs) ?? 1;
  if (!(level > 0)) return 0;
  const ground = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(
    position,
    groundScratch,
  );
  if (!ground) return 0;
  return (
    level *
    awarenessEchoStrength(
      nowMs,
      Cesium.Cartesian3.distance(field.center, ground),
      field.radiusM,
      field.pulse,
      field.echo,
    )
  );
}

/**
 * The echo bracket the detection overlay draws around one contact, or null
 * when it has no echo. `band` is the alpha band, 1 to `steps`, the echo's
 * strength times the contact bracket's own `bracketAlpha` rounded to the
 * nearest band, so an echo is never drawn brighter than its bracket; one
 * that rounds to nothing is not drawn. `spreadPx` is how far the echo sits
 * outside the contact's bracket, 0 as the front arrives, growing to the
 * field's `spreadPx` as it fades.
 * @param {string} layerId Owning layer of the contact.
 * @param {Cesium.Cartesian3} position Contact's world position.
 * @param {number} nowMs Monotonic clock in milliseconds.
 * @param {number} bracketAlpha The contact bracket's drawn alpha, 0 to 1.
 * @param {number} steps Alpha bands the overlay batches by.
 * @returns {{band: number, spreadPx: number}|null}
 */
export function awarenessEchoBracket(
  layerId,
  position,
  nowMs,
  bracketAlpha,
  steps,
) {
  const echo = awarenessEchoAt(layerId, position, nowMs);
  if (!(echo > 0.01)) return null;
  const band = Math.min(steps, Math.round(echo * bracketAlpha * steps));
  if (!(band >= 1)) return null;
  return { band, spreadPx: field.echo.spreadPx * (1 - echo) };
}

/**
 * The echo's stroke colour: the field's own colour on the default detection
 * style, and the style's line colour under the others (NVG, FLIR, CRT), so
 * an echo never stands out of a monochrome palette.
 * @param {string} styleLine The active detection style's line colour.
 * @param {boolean} defaultStyle Whether the default detection style is active.
 * @returns {string|null} Null when no field is set.
 */
export function awarenessEchoColor(styleLine, defaultStyle) {
  if (!field) return null;
  return defaultStyle ? field.echo.color : styleLine;
}
