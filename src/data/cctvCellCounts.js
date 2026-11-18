import { fromDegrees } from '../geo/ellipsoid.js';

/** Exact camera counts below a thousand, then rounded thousands with a K suffix. */
export function formatCameraCount(count) {
  if (count < 1000) return String(count);
  const thousands =
    count < 10000 ? Math.round(count / 100) / 10 : Math.round(count / 1000);
  return `${thousands}K`;
}

/** An empty cell and its on-screen picker candidate. */
export function createCameraCell(key) {
  return {
    key,
    count: 0,
    latSum: 0,
    lonSum: 0,
    heightSum: 0,
    south: Infinity,
    north: -Infinity,
    west: Infinity,
    east: -Infinity,
    low: Infinity,
    high: -Infinity,
    winner: null,
    rank: Infinity,
  };
}

/** Accumulate one horizon-visible mount in its ground cell. */
export function addCellCamera(cell, camera) {
  const { lat, lon, absoluteHeightM: height = 0 } = camera;
  cell.count++;
  // Integer sums make the mean independent of catalog order, to about a centimetre.
  cell.latSum += Math.round(lat * 1e7);
  cell.lonSum += Math.round(lon * 1e7);
  cell.heightSum += Math.round(height * 100);
  cell.south = Math.min(cell.south, lat);
  cell.north = Math.max(cell.north, lat);
  cell.west = Math.min(cell.west, lon);
  cell.east = Math.max(cell.east, lon);
  cell.low = Math.min(cell.low, height);
  cell.high = Math.max(cell.high, height);
}

/** Geographic mean on the globe surface at the mean mount height. */
export function cellCenter(cell) {
  return fromDegrees(
    cell.lonSum / (1e7 * cell.count),
    cell.latSum / (1e7 * cell.count),
    cell.heightSum / (100 * cell.count),
  );
}

/** A padded sphere around the group's geographic rectangle and mount heights. */
export function cellBounds(cell) {
  const lat = (cell.north + cell.south) / 2;
  const lon = (cell.east + cell.west) / 2;
  const height = (cell.high + cell.low) / 2;
  // The parallel nearest the equator bounds the width of every row.
  const parallel = (Math.max(0, cell.south, -cell.north) * Math.PI) / 180;
  // Half the diagonal plus 20% padding on every side.
  const radius =
    0.6 *
    Math.hypot(
      (cell.east - cell.west) * 111_320 * Math.cos(parallel),
      (cell.north - cell.south) * 111_320,
      cell.high - cell.low,
    );
  return { center: fromDegrees(lon, lat, height), radius: Math.max(1, radius) };
}

/** Add a whole ground cell to a marker, retaining the sums for a weighted mean. */
function addCell(target, cell) {
  target.count += cell.count;
  target.latSum += cell.latSum;
  target.lonSum += cell.lonSum;
  target.heightSum += cell.heightSum;
  target.south = Math.min(target.south, cell.south);
  target.north = Math.max(target.north, cell.north);
  target.west = Math.min(target.west, cell.west);
  target.east = Math.max(target.east, cell.east);
  target.low = Math.min(target.low, cell.low);
  target.high = Math.max(target.high, cell.high);
}

/** Claim the touching pills in this marker's bucket and its eight neighbors. */
function collectNeighbors(marker, grid, members, gap) {
  for (let col = -1; col <= 1; col++) {
    for (let row = -1; row <= 1; row++) {
      const bucket = grid.get(`${marker.col + col},${marker.row + row}`);
      if (!bucket) continue;
      for (const other of bucket) {
        // Distance between the horizontal centre segments of the two pills.
        const extra = marker.halfSegment + other.halfSegment;
        const dx = Math.max(0, Math.abs(marker.x - other.x) - extra);
        const dy = marker.y - other.y;
        const reach = marker.radius + other.radius + gap;
        if (dx * dx + dy * dy >= reach * reach) continue;
        bucket.delete(other);
        members.push(other);
      }
    }
  }
}

/**
 * Merge connected groups of overlapping horizontal pills. Each marker occupies
 * one grid bucket. Even the widest pill can only touch its eight neighbors.
 * Ground cells stay intact for the camera picker and individual-icon pass.
 */
export function mergeCountCells(cells, project, sizeFor, gap) {
  let columnWidth = 0;
  let rowHeight = 0;
  const markers = cells.map((cell) => {
    const screen = project(cellCenter(cell));
    const { width, height } = sizeFor(cell.count);
    columnWidth = Math.max(columnWidth, width + gap);
    rowHeight = Math.max(rowHeight, height + gap);
    // The view projector reuses its result object.
    return {
      cell,
      x: screen?.x,
      y: screen?.y,
      halfSegment: (width - height) / 2,
      radius: height / 2,
    };
  });
  const grid = new Map();
  for (const marker of markers) {
    if (!Number.isFinite(marker.x) || !Number.isFinite(marker.y)) continue;
    marker.col = Math.floor(marker.x / columnWidth);
    marker.row = Math.floor(marker.y / rowHeight);
    const key = `${marker.col},${marker.row}`;
    if (!grid.has(key)) grid.set(key, new Set());
    marker.bucket = grid.get(key);
    marker.bucket.add(marker);
  }

  const groups = [];
  const members = [];
  for (const seed of markers) {
    if (!seed.bucket) {
      groups.push(seed.cell);
      continue;
    }
    if (!seed.bucket.delete(seed)) continue;
    members.length = 0;
    members.push(seed);
    for (let i = 0; i < members.length; i++)
      collectNeighbors(members[i], grid, members, gap);

    if (members.length === 1) {
      groups.push(seed.cell);
    } else {
      const group = createCameraCell(seed.cell.key);
      for (const member of members) addCell(group, member.cell);
      groups.push(group);
    }
  }
  return groups;
}
