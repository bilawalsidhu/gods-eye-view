import { GIBS_MAX_LEVEL } from './policy.js';

/** Edge length of a GIBS GoogleMapsCompatible tile, in pixels. */
export const TILE_PIXELS = 256;

/** Latitude beyond which Web Mercator is undefined. */
const MERCATOR_LIMIT_DEG = 85.051129;

/**
 * The tile and pixel covering a geographic point.
 *
 * Web Mercator, matching the EPSG:3857 endpoint the overlay renders from — the
 * sampled pixel has to come from the same projection and matrix set the operator
 * is looking at, or the reading belongs to a different place than the click.
 * @param {number} latitude Degrees north.
 * @param {number} longitude Degrees east.
 * @param {number} level Tile matrix level.
 * @returns {?{level:number, tileX:number, tileY:number, pixelX:number, pixelY:number}} Location, or null outside the projection.
 */
export function locateTilePixel(latitude, longitude, level = GIBS_MAX_LEVEL) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > MERCATOR_LIMIT_DEG) return null;
  const tiles = 2 ** level;
  const x = ((longitude + 180) / 360) * tiles;
  const latitudeRad = (latitude * Math.PI) / 180;
  const y =
    ((1 -
      Math.log(Math.tan(latitudeRad) + 1 / Math.cos(latitudeRad)) / Math.PI) /
      2) *
    tiles;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const tileX = Math.min(tiles - 1, Math.max(0, Math.floor(x)));
  const tileY = Math.min(tiles - 1, Math.max(0, Math.floor(y)));
  return {
    level,
    tileX,
    tileY,
    pixelX: Math.min(TILE_PIXELS - 1, Math.floor((x - tileX) * TILE_PIXELS)),
    pixelY: Math.min(TILE_PIXELS - 1, Math.floor((y - tileY) * TILE_PIXELS)),
  };
}

/**
 * Ground resolution of one sampled pixel, so the readout can say how coarse it
 * is rather than implying the value belongs to the exact clicked spot.
 * @param {number} latitude Degrees north.
 * @param {number} level Tile matrix level.
 * @returns {number} Metres per pixel.
 */
export function metresPerPixel(latitude, level = GIBS_MAX_LEVEL) {
  const equatorial = 40_075_016.686;
  return (
    (equatorial * Math.cos((latitude * Math.PI) / 180)) /
    (TILE_PIXELS * 2 ** level)
  );
}
