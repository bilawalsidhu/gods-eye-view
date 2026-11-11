import * as geo from '../../geo/index.js';

// The small rectangle operations used by FIRMS, on plain radian bounds.
export function rectangleWidth(rectangle) {
  let east = rectangle.east;
  if (east < rectangle.west) east += geo.math.TWO_PI;
  return east - rectangle.west;
}
export function rectangleHeight(rectangle) {
  return rectangle.north - rectangle.south;
}
export function rectangleCenter(rectangle, result) {
  let east = rectangle.east;
  if (east < rectangle.west) east += geo.math.TWO_PI;
  result.longitude = geo.math.negativePiToPi((rectangle.west + east) * 0.5);
  result.latitude = (rectangle.south + rectangle.north) * 0.5;
  result.height = 0;
  return result;
}
export function cloneRectangle(rectangle) {
  return {
    west: rectangle.west,
    south: rectangle.south,
    east: rectangle.east,
    north: rectangle.north,
  };
}
