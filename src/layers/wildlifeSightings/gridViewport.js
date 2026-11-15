// Observation icons share 28px screen buckets. The density glow uses finer
// 8–14px logical cells, coarsened until the complete view fits the tile budget.
export const WILDLIFE_GRID_TARGET_SPACING_PX = 28;
export const WILDLIFE_GRID_SAMPLE_SPACING_PX = 14;
export const WILDLIFE_GRID_TILE_CAP = 6;
export const WILDLIFE_GRID_MAX_ZOOM = 22;
// The 64×64 UTFGrid is a hit mask: each logical 8px observation bin
// occupies 2×2 of its 4px pixels, plus a dilated hit outline. Returned centres
// are at odd pixel coordinates. Count logical bins once, not hit-mask pixels.
export const WILDLIFE_GRID_LOGICAL_SIZE = 32;
const MAX_LATITUDE = 85.0511287798066;
const degrees = (radians) => (radians * 180) / Math.PI;
const latitudeY = (latitude) => {
  const radians =
    (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude)) * Math.PI) / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
};
const yLatitude = (value) =>
  degrees(Math.atan(Math.sinh(Math.PI * (1 - 2 * value))));
const validBox = (box) =>
  !!box &&
  ['south', 'west', 'north', 'east'].every((key) =>
    Number.isFinite(box[key]),
  ) &&
  box.south >= -90 &&
  box.north <= 90 &&
  box.north > box.south &&
  box.west >= -180 &&
  box.west <= 180 &&
  box.east >= -180 &&
  box.east <= 180 &&
  box.west !== box.east;

function normalizedBoxes(boxes) {
  if (!Array.isArray(boxes) || !boxes.length || !boxes.every(validBox))
    return [];
  return boxes
    .flatMap((box) =>
      box.west < box.east
        ? [box]
        : [
            { ...box, east: 180 },
            { ...box, west: -180 },
          ],
    )
    .filter((box) => box.east > box.west);
}

function tileRanges(boxes, z) {
  const count = 2 ** z;
  const index = (value) => Math.max(0, Math.min(count - 1, Math.floor(value)));
  return normalizedBoxes(boxes).map((box) => ({
    left: index(((box.west + 180) / 360) * count),
    right: index(((box.east + 180) / 360) * count - 1e-9),
    top: index(latitudeY(box.north) * count),
    bottom: index(latitudeY(box.south) * count - 1e-9),
  }));
}

function tileCount(boxes, z) {
  // Split antimeridian ranges cannot overlap except at z=0. Counting that
  // shared tile twice merely makes the request cap slightly conservative.
  return tileRanges(boxes, z).reduce(
    (sum, range) =>
      sum + (range.right - range.left + 1) * (range.bottom - range.top + 1),
    0,
  );
}

/** Choose the finest glow spacing whose full viewport fits the tile budget. */
export function chooseWildlifeGridZoom({ boxes, width, height } = {}) {
  const visible = normalizedBoxes(boxes);
  if (!visible.length || !(width > 0) || !(height > 0)) return 0;
  const horizontalSpan = Math.min(
    1,
    visible.reduce((sum, box) => sum + (box.east - box.west) / 360, 0),
  );
  const verticalSpan = Math.max(
    ...visible.map((box) => latitudeY(box.south) - latitudeY(box.north)),
  );
  const pixelsPerWorld = Math.min(
    width / horizontalSpan,
    height / Math.max(1e-9, verticalSpan),
  );
  let z = Math.max(
    0,
    Math.min(
      WILDLIFE_GRID_MAX_ZOOM,
      Math.ceil(
        Math.log2(
          pixelsPerWorld /
            (WILDLIFE_GRID_LOGICAL_SIZE * WILDLIFE_GRID_SAMPLE_SPACING_PX),
        ) - 1e-9,
      ),
    ),
  );
  while (z > 0 && tileCount(visible, z) > WILDLIFE_GRID_TILE_CAP) z -= 1;
  return z;
}

/** Only intersecting tiles, in stable XYZ order, with no neighboring padding.
 * Direct oversized requests fail closed; zoom selection coarsens beforehand. */
export function wildlifeGridTiles({ boxes, z } = {}) {
  if (!Number.isInteger(z) || z < 0 || z > WILDLIFE_GRID_MAX_ZOOM) return [];
  if (tileCount(boxes, z) > WILDLIFE_GRID_TILE_CAP) return [];
  const tiles = new Map();
  for (const range of tileRanges(boxes, z)) {
    for (let x = range.left; x <= range.right; x += 1) {
      for (let y = range.top; y <= range.bottom; y += 1) {
        tiles.set(`${x}/${y}`, { z, x, y });
      }
    }
  }
  return [...tiles.values()].sort((a, b) => a.x - b.x || a.y - b.y);
}

/** Unlike detail-row viewport queries, grids cover full globe views too. */
export function wildlifeGridViewportBoxes(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle?.(
    viewer?.scene?.globe?.ellipsoid,
  );
  if (!rectangle) return [];
  return normalizedBoxes([
    Object.fromEntries(
      ['south', 'west', 'north', 'east'].map((key) => [
        key,
        Math.round(degrees(rectangle[key]) * 1e8) / 1e8,
      ]),
    ),
  ]);
}

/** Return the geographic footprint of one logical occupied cell. */
export function wildlifeGridCellBounds(id) {
  const match = /^grid:(\d+)\/(\d+)\/(\d+):(\d+):(\d+)$/.exec(id);
  if (!match) return null;
  const [z, x, y, row, column] = match.slice(1).map(Number);
  const count = 2 ** z;
  if (
    z > WILDLIFE_GRID_MAX_ZOOM ||
    x >= count ||
    y >= count ||
    row >= 64 ||
    column >= 64
  )
    return null;
  return {
    south: yLatitude((y + (Math.floor(row / 2) + 1) / 32) / count),
    west: ((x + Math.floor(column / 2) / 32) / count) * 360 - 180,
    north: yLatitude((y + Math.floor(row / 2) / 32) / count),
    east: ((x + (Math.floor(column / 2) + 1) / 32) / count) * 360 - 180,
  };
}

/** Shared with the proxy and cached-coverage matching. A tile's hit area can
 * bleed into its neighbor; the geographic owner makes ids stable. */
export function wildlifeGridCellId(lat, lon, z) {
  if (
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    !Number.isFinite(lon) ||
    Math.abs(lon) > 180 ||
    !Number.isInteger(z) ||
    z < 0 ||
    z > WILDLIFE_GRID_MAX_ZOOM
  )
    return null;
  const count = 2 ** z;
  const worldX = ((((lon + 180) / 360) % 1) + 1) % 1;
  const worldY = Math.max(0, Math.min(1 - Number.EPSILON, latitudeY(lat)));
  const tileX = Math.min(count - 1, Math.floor(worldX * count));
  const tileY = Math.min(count - 1, Math.floor(worldY * count));
  const column =
    Math.min(31, Math.floor((worldX * count - tileX) * 32 + 1e-8)) * 2 + 1;
  const row =
    Math.min(31, Math.floor((worldY * count - tileY) * 32 + 1e-8)) * 2 + 1;
  return `grid:${z}/${tileX}/${tileY}:${row}:${column}`;
}
