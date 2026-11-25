import { fromDegrees } from '../geo/ellipsoid.js';

/** Exact below 1,000, then K with one decimal below 10K. Uses Latin digits in every locale. */
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

const wrapLongitude = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Mean longitude and latitude of a cell's mounts, in degrees. */
export function cellLonLat(cell) {
  return {
    lon: wrapLongitude(cell.lonSum / (1e7 * cell.count)),
    lat: cell.latSum / (1e7 * cell.count),
  };
}

/**
 * Geographic mean of the mounts. Its height is the drawn ground under it
 * when the cell carries one (`groundM`), since a camera nobody has looked at
 * yet may still hold a catalog height far from the terrain; otherwise the
 * mean mount height.
 */
export function cellCenter(cell) {
  const { lon, lat } = cellLonLat(cell);
  return fromDegrees(
    lon,
    lat,
    Number.isFinite(cell.groundM)
      ? cell.groundM
      : cell.heightSum / (100 * cell.count),
  );
}

/** Half the east-west and north-south ground extent of a cell's mounts, in metres. */
export function cellHalfExtents(cell) {
  // The parallel nearest the equator bounds the width of every row.
  const parallel = (Math.max(0, cell.south, -cell.north) * Math.PI) / 180;
  return {
    halfWidthM: 0.5 * (cell.east - cell.west) * 111_320 * Math.cos(parallel),
    halfHeightM: 0.5 * (cell.north - cell.south) * 111_320,
  };
}

/** A padded sphere over the rectangle and every mount, centred at groundM
 * when set, otherwise at the mid mount height. */
export function cellBounds(cell) {
  const lat = (cell.north + cell.south) / 2;
  const lon = wrapLongitude((cell.east + cell.west) / 2);
  const height = Number.isFinite(cell.groundM)
    ? cell.groundM
    : (cell.high + cell.low) / 2;
  const { halfWidthM, halfHeightM } = cellHalfExtents(cell);
  const halfWidth = Math.hypot(halfWidthM, halfHeightM);
  const vertical = Math.max(cell.high - height, height - cell.low);
  const radius = 1.2 * Math.hypot(halfWidth, vertical);
  return { center: fromDegrees(lon, lat, height), radius: Math.max(1, radius) };
}

/** Add a whole ground cell to a marker, retaining the sums for a weighted mean. */
function addCell(target, cell) {
  // Across the antimeridian a cell joins on the side of the group's mean.
  const shift = target.count
    ? 360 *
      Math.round(
        (target.lonSum / target.count - cell.lonSum / cell.count) / 3.6e9,
      )
    : 0;
  target.count += cell.count;
  target.latSum += cell.latSum;
  target.lonSum += cell.lonSum + shift * 1e7 * cell.count;
  target.heightSum += cell.heightSum;
  target.south = Math.min(target.south, cell.south);
  target.north = Math.max(target.north, cell.north);
  target.west = Math.min(target.west, cell.west + shift);
  target.east = Math.max(target.east, cell.east + shift);
  target.low = Math.min(target.low, cell.low);
  target.high = Math.max(target.high, cell.high);
}

/** Visit the touching pills in this marker's bucket and its eight neighbors. */
function visitNeighbors(marker, grid, gap, visit) {
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
        visit(other, dx * dx + dy * dy, reach);
      }
    }
  }
}

/**
 * Merge connected groups of overlapping horizontal pills. Each marker occupies
 * one grid bucket. Even the widest pill can only touch its eight neighbors.
 * A cell with one camera takes the footprint `sizeFor(1)` gives its icon and
 * joins the nearest count it touches. Lone cameras never join each other
 * or bridge two counts. A spread icon's `offsetPx` shifts its footprint sideways.
 * A merged group lists its ground cells in `parts`.
 * Ground cells stay intact for the camera picker and individual-icon pass.
 */
export function mergeCountCells(cells, project, sizeFor, gap) {
  let columnWidth = 0;
  let rowHeight = 0;
  const markers = cells.map((cell) => {
    const screen = project(cellCenter(cell));
    const { width, height } = sizeFor(cell.count, cell);
    columnWidth = Math.max(columnWidth, width + gap);
    rowHeight = Math.max(rowHeight, height + gap);
    // The view projector reuses its result object.
    return {
      cell,
      x: screen ? screen.x + (cell.offsetPx ?? 0) : undefined,
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
    if (marker.cell.count > 1) marker.bucket.add(marker);
  }

  for (const marker of markers) {
    if (marker.cell.count !== 1 || !marker.bucket) continue;
    let best = Infinity;
    visitNeighbors(marker, grid, gap, (other, distanceSquared, reach) => {
      const clearance = Math.sqrt(distanceSquared) - reach;
      if (clearance < best) {
        best = clearance;
        marker.nearest = other;
      }
    });
  }

  // Only counts were candidates for nearest. Now they can claim lone cameras.
  for (const marker of markers)
    if (marker.cell.count === 1) marker.bucket?.add(marker);

  const members = [];
  for (const seed of markers) {
    if (seed.cell.count === 1 || !seed.bucket?.delete(seed)) continue;
    members.length = 0;
    members.push(seed);
    for (const marker of members) {
      if (marker.cell.count === 1) continue;
      visitNeighbors(marker, grid, gap, (other) => {
        if (other.cell.count === 1 && other.nearest !== marker) return;
        other.bucket.delete(other);
        members.push(other);
      });
    }
    if (members.length === 1) {
      seed.result = seed.cell;
    } else {
      const group = createCameraCell(seed.cell.key);
      group.lone = [];
      group.parts = [];
      for (const { cell } of members) {
        addCell(group, cell);
        group.parts.push(...(cell.parts ?? [cell]));
        if (cell.count === 1) group.lone.push(cell);
        else if (cell.lone) group.lone.push(...cell.lone);
      }
      seed.result = group;
    }
  }

  const groups = [];
  for (const marker of markers) {
    if (marker.result) groups.push(marker.result);
    else if (!marker.bucket || marker.bucket.has(marker))
      groups.push(marker.cell);
  }
  return groups;
}

/** Rebuild a group's count under its original key, keeping only the lone cameras in `keep`. */
export function withoutLoneCameras(group, keep = []) {
  const counts = (group.parts ?? []).filter((cell) => cell.count > 1);
  if (!counts.length) return null;
  const core = createCameraCell(group.key);
  core.parts = [...counts, ...keep];
  if (keep.length) core.lone = [...keep];
  for (const cell of core.parts) addCell(core, cell);
  return core;
}
