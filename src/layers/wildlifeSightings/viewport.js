import {
  WILDLIFE_MAX_VIEW_DEGREES,
  WILDLIFE_RETRY_MIN_MS,
  WILDLIFE_RETRY_MAX_MS,
} from './policy.js';

export { snapWildlifeBox } from './bounds.js';

const degrees = (radians) => (radians * 180) / Math.PI;
const cleanDegree = (value) => Math.round(value * 1e8) / 1e8;

function validBox(box) {
  return (
    !!box &&
    ['south', 'west', 'north', 'east'].every((key) =>
      Number.isFinite(box[key]),
    ) &&
    box.south >= -90 &&
    box.north <= 90 &&
    box.north >= box.south &&
    box.west >= -180 &&
    box.west <= 180 &&
    box.east >= -180 &&
    box.east <= 180
  );
}

function longitudeRanges(box) {
  return box.west <= box.east
    ? [[box.west, box.east]]
    : [
        [box.west, 180],
        [-180, box.east],
      ];
}

/** Test geographic overlap, including boxes that cross the antimeridian. */
export function boxIntersects(a, b) {
  if (!validBox(a) || !validBox(b) || a.south > b.north || a.north < b.south)
    return false;
  return longitudeRanges(a).some(([aw, ae]) =>
    longitudeRanges(b).some(([bw, be]) => aw <= be && ae >= bw),
  );
}

/** Split a local camera rectangle into noncrossing observation query boxes. */
export function wildlifeViewportBoxes(viewer) {
  const camera = viewer?.camera;
  if (typeof camera?.computeViewRectangle !== 'function') return null;
  const rectangle = camera.computeViewRectangle(
    viewer?.scene?.globe?.ellipsoid,
  );
  if (!rectangle) return null;
  const box = Object.fromEntries(
    ['south', 'west', 'north', 'east'].map((key) => [
      key,
      cleanDegree(degrees(rectangle[key])),
    ]),
  );
  if (!validBox(box) || box.north <= box.south) return null;
  const width =
    box.east >= box.west ? box.east - box.west : 360 - box.west + box.east;
  if (
    width <= 0 ||
    Math.max(box.north - box.south, width) > WILDLIFE_MAX_VIEW_DEGREES
  )
    return null;
  return longitudeRanges(box)
    .filter(([west, east]) => east > west)
    .map(([west, east]) => ({
      south: box.south,
      west,
      north: box.north,
      east,
    }));
}

/** 30 seconds, doubling to a four-minute ceiling, for local retry guidance. */
export function retryDelayMs(previousMs) {
  return Number.isFinite(previousMs) && previousMs > 0
    ? Math.min(WILDLIFE_RETRY_MAX_MS, previousMs * 2)
    : WILDLIFE_RETRY_MIN_MS;
}
