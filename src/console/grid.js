import { forward as toMgrs } from 'mgrs';
import { formatGridReference } from './format.js';

/**
 * Grid-reference adapter.
 *
 * The one place the console binds to the `mgrs` package, mirroring how
 * `src/hud.js` reaches for the same projection. Everything else about the
 * readout — the latitude-band guard, the spacing, the placeholder — belongs to
 * `formatGridReference`, which takes the projector as an argument so it stays
 * testable outside a bundler.
 *
 * @param {number} latitude Degrees north.
 * @param {number} longitude Degrees east.
 * @returns {string} `18S UJ 2337 0716`, or the readout placeholder.
 */
export function gridReference(latitude, longitude) {
  return formatGridReference(latitude, longitude, (lon, lat) =>
    toMgrs([lon, lat], 4),
  );
}
