/**
 * @module geo/rectangle
 * @description Geodetic rectangles `{west, south, east, north}` in radians,
 * as the default renderer measures them: a rectangle whose east is less
 * than its west crosses the antimeridian.
 */
import { TWO_PI, negativePiToPi } from './vector.js';

/** East-west extent, radians, across the antimeridian too. */
export function rectangleWidth({ west, east }) {
  return (east < west ? east + TWO_PI : east) - west;
}

/** North-south extent, radians. */
export const rectangleHeight = ({ south, north }) => north - south;

/** The middle `{lon, lat}`, radians, across the antimeridian too. */
export function rectangleCenter({ west, south, east, north }) {
  return {
    lon: negativePiToPi((west + (east < west ? east + TWO_PI : east)) / 2),
    lat: (south + north) / 2,
  };
}
