/**
 * How a fleet model's draw item is turned, stretched and coloured
 * (`fleetModelInstances.js`): pure, no renderer, so it can be read without
 * the draw port.
 */

/** Every fleet GLB is nose -X: opposite the draw contract's heading 0. */
export const FLEET_HEADING_OFFSET_DEG = 180;

/**
 * The pitch and roll (radians) that lay a vessel's deck on a sea surface
 * rising `slope` metres per metre east and north, for a model drawn facing
 * `headingDeg` (clockwise from north) turned by FLEET_HEADING_OFFSET_DEG. In
 * the draw contract's heading-pitch-roll frame the turned model's x is then
 * its port side and its y its stern: pitch raises the port side, roll the
 * stern. The roll is taken after the pitch, as the frame composes them, so
 * the deck lies on the slope exactly. Level (0, 0) without a finite slope.
 * @param {number} headingDeg
 * @param {{east: number, north: number}|null|undefined} slope
 * @returns {{pitch: number, roll: number}}
 */
export function fleetModelTilt(headingDeg, slope) {
  if (!slope || !Number.isFinite(slope.east) || !Number.isFinite(slope.north))
    return { pitch: 0, roll: 0 };
  const c = (headingDeg || 0) * (Math.PI / 180);
  const port = -slope.east * Math.cos(c) + slope.north * Math.sin(c);
  const stern = -(slope.east * Math.sin(c) + slope.north * Math.cos(c));
  const pitch = Math.atan(port);
  return { pitch, roll: Math.atan(stern * Math.cos(pitch)) };
}

/**
 * A colour as the draw contract takes it: a CSS string or `[r, g, b, a]`
 * as given, `{red, green, blue, alpha}` as an array; null for none.
 */
export function fleetColor(color) {
  if (color === undefined || color === null) return null;
  if (typeof color === 'string' || Array.isArray(color)) return color;
  if (typeof color.red === 'number')
    return [color.red, color.green, color.blue, color.alpha ?? 1];
  return null;
}

/**
 * The per-axis stretch a fleet spec draws with on top of its length scale,
 * along the model's glTF axes (`x` its length, `y` its height, `z` its
 * beam), or undefined when it keeps its proportions.
 * @param {object} spec `fleetModelSpec`.
 * @returns {[number, number, number]|undefined}
 */
export function fleetAxisScale(spec) {
  const [length, beam, height] = spec?.scaleXYZ ?? [];
  if (!(length > 0) || (beam === length && height === length)) return;
  return [1, height / length, beam / length];
}
