import * as geo from '../../geo/index.js';

/**
 * The centre of a view rectangle (radians), across the antimeridian when
 * its east edge is west of its west edge.
 * @param {{ west: number, south: number, east: number, north: number }} rect
 * @returns {{ latitude: number, longitude: number }}
 */
export function viewRectangleCenter(rect) {
  const east = rect.east < rect.west ? rect.east + Math.PI * 2 : rect.east;
  return {
    latitude: (rect.south + rect.north) / 2,
    longitude: geo.math.negativePiToPi((rect.west + east) / 2),
  };
}
