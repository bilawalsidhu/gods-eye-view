// The data of Navara's ground pass (pass.js), without three: each item in a
// gnomonic frame of its own (the tangent plane at its centre, reached along
// rays from the Earth's centre, where great-circle edges are straight
// lines), its boundary as segments in that plane, in float64 until the
// numbers are small; per camera change the frames in view space, each
// item's conservative screen box and a screen grid of candidate items,
// kept in draw order.

import * as geo from '../../../geo/index.js';
import { cellRing } from '../../ground.js';

const { cartesian3 } = geo;

/** Item kinds as the shader reads them. */
export const KIND = Object.freeze({
  area: 0,
  disc: 1,
  corridorPx: 2,
  corridorM: 3,
});
export const GRID_COLS = 64;
export const GRID_ROWS = 40;
/** RGBA32F texels per pass item in the frame texture. */
export const TEXELS = 4;
/** RGBA32F texels per pass item in the style texture. */
export const STYLE_TEXELS = 6;
/** An area of more segments than this gets a grid of bins (binArea). */
export const BIN_THRESHOLD = 32;
const MAX_BINS = 32;
/** Segments of a corridor drawn as one pass item. */
export const CORRIDOR_CHUNK = 4;
/** Texture rows hold this many texels. */
export const ROW = 1024;

// Highest ground above the ellipsoid a fill reaches (the item's volume).
const CEILING_M = 9000;
// Lowest: Navara's globe mesh can lie well under the ellipsoid at orbital
// detail (−26 km measured over Alaska); Cesium's GroundPrimitive floor.
const FLOOR_M = -100000;
// The floor of an item's screen box: as deep as the terrain's level of
// detail can put the ground at that distance (a kilometre plus 5 % of the
// distance), down to FLOOR_M. A box to −100 km for a near item streaks
// across the screen and makes it a candidate of cells it never covers.
const nearFloor = (distance) => -Math.min(-FLOOR_M, 1000 + 0.05 * distance);
// Where the terrain under an item was sampled, its box spans the sampled
// heights, less the error of the terrain's level of detail at that distance
// (100 m plus 2 %) below, and above that error plus room for 3D tiles'
// buildings over the terrain.
// Terrain is sampled on a grid of 0.005° (about 500 m), and the box
// widened by 350 m each way for the slopes between samples.
const SAMPLE_STEP_DEG = 0.005;
const lodMargin = (distance) => 450 + 0.02 * distance;
const TILE_HEADROOM_M = 900;
/** Terrain samples per pass item. */
const SAMPLES = 9;
const CELL_STEP_DEG = 0.25;

function frameAt(lon, lat) {
  const center = cartesian3.fromDegrees(lon, lat);
  const radius = cartesian3.magnitude(center);
  const up = cartesian3.divideByScalar(center, radius, cartesian3.create());
  const east = cartesian3.normalize(
    cartesian3.create(-center.y, center.x, 0),
    cartesian3.create(),
  );
  if (!Number.isFinite(east.x)) Object.assign(east, { x: 1, y: 0, z: 0 });
  const north = cartesian3.cross(up, east, cartesian3.create());
  const scratch = cartesian3.create();
  // A ground position in the frame's gnomonic plane, metres.
  const project = (lonDeg, latDeg) => {
    cartesian3.fromDegrees(lonDeg, latDeg, 0, undefined, scratch);
    const dx = scratch.x - center.x;
    const dy = scratch.y - center.y;
    const dz = scratch.z - center.z;
    const scale = radius / (radius + dx * up.x + dy * up.y + dz * up.z);
    return [
      (dx * east.x + dy * east.y + dz * east.z) * scale,
      (dx * north.x + dy * north.y + dz * north.z) * scale,
    ];
  };
  return { center, radius, up, east, north, project };
}

// A path's points in a frame's plane.
const planePoints = (flat, project) => {
  const points = [];
  for (let index = 0; index < flat.length; index += 2)
    points.push(project(flat[index], flat[index + 1]));
  return points;
};

/**
 * A grid of square bins over an area's segments (flat [ax, ay, bx, by, …]
 * in its plane) when it has more than BIN_THRESHOLD: the grid covers the
 * segments' bounds and half a bin round them; each bin lists the segments
 * that reach within half a bin of it and whether its centre is inside the
 * area (even-odd). A pixel then tests only its bin's segments: the nearest
 * one, and the crossings between it and the bin's centre. Null for a
 * smaller area.
 */
export function binArea(list) {
  const count = list.length / 4;
  if (count <= BIN_THRESHOLD) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < list.length; index += 2) {
    minX = Math.min(minX, list[index]);
    maxX = Math.max(maxX, list[index]);
    minY = Math.min(minY, list[index + 1]);
    maxY = Math.max(maxY, list[index + 1]);
  }
  const across = Math.min(
    MAX_BINS,
    Math.max(2, Math.ceil(Math.sqrt(count / 4))),
  );
  const size = Math.max(maxX - minX, maxY - minY, 1e-3) / across;
  const x = minX - size / 2;
  const y = minY - size / 2;
  const columns = Math.ceil((maxX - minX + size) / size) || 1;
  const rows = Math.ceil((maxY - minY + size) / size) || 1;
  const cells = Array.from({ length: columns * rows }, () => []);
  const clampTo = (value, max) => Math.min(max - 1, Math.max(0, value));
  for (let index = 0; index < count; index++) {
    const [ax, ay, bx, by] = list.slice(index * 4, index * 4 + 4);
    const x0 = clampTo(
      Math.floor((Math.min(ax, bx) - x) / size - 0.5),
      columns,
    );
    const x1 = clampTo(
      Math.floor((Math.max(ax, bx) - x) / size + 0.5),
      columns,
    );
    const y0 = clampTo(Math.floor((Math.min(ay, by) - y) / size - 0.5), rows);
    const y1 = clampTo(Math.floor((Math.max(ay, by) - y) / size + 0.5), rows);
    for (let row = y0; row <= y1; row++)
      for (let column = x0; column <= x1; column++)
        cells[row * columns + column].push(index);
  }
  const insideAt = (px, py) => {
    let inside = false;
    for (let index = 0; index < list.length; index += 4) {
      const ay = list[index + 1];
      const by = list[index + 3];
      if (
        ay > py !== by > py &&
        px <
          ((list[index + 2] - list[index]) * (py - ay)) / (by - ay) +
            list[index]
      )
        inside = !inside;
    }
    return inside;
  };
  return {
    x,
    y,
    size,
    columns,
    rows,
    bins: cells.map((indices, cell) => ({
      count: indices.length,
      inside: insideAt(
        x + ((cell % columns) + 0.5) * size,
        y + (Math.floor(cell / columns) + 0.5) * size,
      )
        ? 1
        : 0,
      list: indices.flatMap((index) => list.slice(index * 4, index * 4 + 4)),
    })),
  };
}

/**
 * One set's items packed for the pass as pass items: float64 frames, the
 * terrain heights under each (`terrainHeight(lon, lat)`, undefined where
 * not loaded: that item keeps the deep default box), the
 * style texels (segment starts relative to the set's own segments) and the
 * segments. A corridor longer than CORRIDOR_CHUNK segments becomes one pass
 * item per chunk, each in its own plane with its own screen box; a chunk
 * also holds its neighbours' end segments and draws only where its own
 * segments are the nearest, so joints blend once.
 */
export function packSet(kind, items, { terrainHeight = null } = {}) {
  const frames = [];
  const styles = [];
  const volumes = [];
  const heights = [];
  const segments = [];
  const bins = [];
  // Terrain heights on a grid of SAMPLE_STEP_DEG, each sampled once.
  const sampled = new Map();
  const heightAt = (lon, lat) => {
    const x = Math.round(lon / SAMPLE_STEP_DEG);
    const y = Math.round(lat / SAMPLE_STEP_DEG);
    const key = x * 1e6 + y;
    if (!sampled.has(key))
      sampled.set(
        key,
        terrainHeight?.(x * SAMPLE_STEP_DEG, y * SAMPLE_STEP_DEG),
      );
    return sampled.get(key);
  };
  // The lowest and highest terrain under a pass item's sample positions
  // (flat [lon, lat, …], at most SAMPLES of them), NaN when unknown.
  const sampleHeights = (flat) => {
    if (!terrainHeight) return [Number.NaN, Number.NaN];
    let low = Infinity;
    let high = -Infinity;
    const count = flat.length / 2;
    const step = Math.max(1, Math.ceil(count / SAMPLES));
    for (let index = 0; index < count; index += step) {
      const height = heightAt(flat[index * 2], flat[index * 2 + 1]);
      if (!Number.isFinite(height)) return [Number.NaN, Number.NaN];
      low = Math.min(low, height);
      high = Math.max(high, height);
    }
    return [low, high];
  };
  const emit = (frame, style, extent, padPx, list, samples, extra = null) => {
    heights.push(...sampleHeights(samples));
    const start = segments.length / 4;
    segments.push(...list);
    if (extra) {
      // The bins' own segment lists follow the item's, relative to its start.
      style.bins[3] = bins.length / 4;
      for (const bin of extra.bins) {
        bins.push(segments.length / 4 - start, bin.count, bin.inside, 0);
        segments.push(...bin.list);
      }
    }
    const radius = extent * (1 + 101000 / frame.radius) + 1;
    const floor = FLOOR_M - ((radius * radius) / (2 * frame.radius)) * 1.1;
    frames.push(
      frame.center.x,
      frame.center.y,
      frame.center.z,
      frame.east.x,
      frame.east.y,
      frame.east.z,
      frame.north.x,
      frame.north.y,
      frame.north.z,
      frame.up.x,
      frame.up.y,
      frame.up.z,
      frame.radius,
    );
    volumes.push(radius, floor, CEILING_M, padPx + 2);
    styles.push(
      ...style.fill,
      ...style.line,
      ...style.shape,
      floor,
      CEILING_M,
      start,
      list.length / 4,
      ...style.bins,
      ...style.origin,
    );
  };
  const segmentsOf = (points, closed) => {
    const list = [];
    const last = closed ? points.length : points.length - 1;
    for (let index = 0; index < last; index++) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      list.push(a[0], a[1], b[0], b[1]);
    }
    return list;
  };
  const reach = (points) =>
    points.reduce((most, [x, y]) => Math.max(most, Math.hypot(x, y)), 0);
  for (const item of items) {
    const none = [0, 0, 0, 0];
    if (kind === 'corridor') {
      const code = item.widthM ? KIND.corridorM : KIND.corridorPx;
      const segmentCount = item.path.length / 2 - 1;
      for (let first = 0; first < segmentCount; first += CORRIDOR_CHUNK) {
        const own = Math.min(CORRIDOR_CHUNK, segmentCount - first);
        const from = Math.max(0, first - 1);
        const to = Math.min(segmentCount, first + own + 1);
        const part = item.path.subarray(from * 2, (to + 1) * 2);
        let west = Infinity;
        let east = -Infinity;
        let south = Infinity;
        let north = -Infinity;
        for (let at = 0; at < part.length; at += 2) {
          west = Math.min(west, part[at]);
          east = Math.max(east, part[at]);
          south = Math.min(south, part[at + 1]);
          north = Math.max(north, part[at + 1]);
        }
        const frame = frameAt((west + east) / 2, (south + north) / 2);
        const points = planePoints(part, frame.project);
        emit(
          frame,
          {
            fill: item.fill,
            line: none,
            shape: [code, 0, item.widthPx ?? 0, item.widthM ?? 0],
            bins: [first - from, own, 0, 0],
            origin: [0, 0, 0, 0],
          },
          reach(points) + (item.widthM ?? 0) / 2,
          (item.widthPx ?? 0) / 2,
          segmentsOf(points, false),
          part,
        );
      }
      continue;
    }
    const style = {
      fill: item.fill ?? none,
      line: item.outline?.color ?? none,
      shape: [KIND.area, item.outline?.widthPx ?? 0, 0, 0],
      bins: [0, 0, 0, 0],
      origin: [0, 0, 0, 0],
    };
    const padPx = (item.outline?.widthPx ?? 0) / 2;
    if (kind === 'disc') {
      const frame = frameAt(item.center[0], item.center[1]);
      const radius = frame.radius * Math.tan(item.radiusM / frame.radius);
      style.shape = [KIND.disc, item.outline?.widthPx ?? 0, 0, radius];
      emit(
        frame,
        style,
        radius,
        padPx,
        [],
        Float64Array.of(
          ...item.center,
          item.bounds.west,
          item.center[1],
          item.bounds.east,
          item.center[1],
          item.center[0],
          item.bounds.south,
          item.center[0],
          item.bounds.north,
        ),
      );
      continue;
    }
    const { bounds } = item;
    const frame = frameAt(
      (bounds.west + bounds.east) / 2,
      (bounds.south + bounds.north) / 2,
    );
    const rings = (
      kind === 'cell' ? [cellRing(item, CELL_STEP_DEG)] : item.rings
    ).map((ring) => planePoints(ring, frame.project));
    const list = rings.flatMap((ring) => segmentsOf(ring, true));
    const binned = binArea(list);
    if (binned) {
      style.bins = [binned.columns, binned.rows, binned.size, 0];
      style.origin = [binned.x, binned.y, 0, 0];
    }
    emit(
      frame,
      style,
      Math.max(...rings.map(reach)),
      padPx,
      list,
      Float64Array.of(
        (bounds.west + bounds.east) / 2,
        (bounds.south + bounds.north) / 2,
        ...(kind === 'cell' ? cellRing(item, CELL_STEP_DEG) : item.rings[0]),
      ),
      binned,
    );
  }
  return {
    count: volumes.length / 4,
    bins: Float32Array.from(bins),
    heights: Float64Array.from(heights),
    frames: Float64Array.from(frames),
    styles: Float32Array.from(styles),
    volumes: Float64Array.from(volumes),
    segments: Float32Array.from(segments),
  };
}

/** Storage for `texels` RGBA texels in rows of ROW. */
export function texelStorage(texels) {
  const width = Math.min(ROW, Math.max(1, texels));
  const height = Math.max(1, Math.ceil(texels / width));
  return { width, height, data: new Float32Array(width * height * 4) };
}

/** Conservative clip box of an item's volume in view space, or 2s off screen. */
export function clipBounds(view, radius, floor, ceiling, projection, out) {
  const p = projection;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let front = 0;
  let behind = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = (corner & 1 ? 1 : -1) * radius;
    const y = (corner & 2 ? 1 : -1) * radius;
    const z = corner & 4 ? ceiling : floor;
    const vx = view[0] + view[3] * x + view[6] * y + view[9] * z;
    const vy = view[1] + view[4] * x + view[7] * y + view[10] * z;
    const vz = view[2] + view[5] * x + view[8] * y + view[11] * z;
    const w = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    if (w <= 0) {
      behind++;
      continue;
    }
    front++;
    const cx = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / w;
    const cy = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / w;
    x0 = Math.min(x0, cx);
    y0 = Math.min(y0, cy);
    x1 = Math.max(x1, cx);
    y1 = Math.max(y1, cy);
  }
  if (front && behind) {
    x0 = -1;
    y0 = -1;
    x1 = 1;
    y1 = 1;
  }
  if (!front || x1 < -1 || y1 < -1 || x0 > 1 || y0 > 1) out.fill(2);
  else {
    out[0] = Math.max(-1, x0);
    out[1] = Math.max(-1, y0);
    out[2] = Math.min(1, x1);
    out[3] = Math.min(1, y1);
  }
  return out;
}

/**
 * The drawn sets (packSet results, in draw order) as one pass state:
 * static textures data (styles, segments) and update(view, projection,
 * width, height), which refreshes the frames in view space and the grid
 * of candidates when the camera or the viewport changed (true then).
 */
export function composeGround(packs) {
  const count = packs.reduce((total, pack) => total + pack.count, 0);
  const segmentCount = packs.reduce(
    (total, pack) => total + pack.segments.length / 4,
    0,
  );
  const frames64 = new Float64Array(count * 13);
  const volumes = new Float64Array(count * 4);
  const heights = new Float64Array(count * 2);
  const styles = texelStorage(count * STYLE_TEXELS);
  const segments = texelStorage(segmentCount);
  const bins = texelStorage(
    packs.reduce((total, pack) => total + pack.bins.length / 4, 0),
  );
  let item = 0;
  let segment = 0;
  let bin = 0;
  for (const pack of packs) {
    frames64.set(pack.frames, item * 13);
    volumes.set(pack.volumes, item * 4);
    heights.set(pack.heights, item * 2);
    styles.data.set(pack.styles, item * STYLE_TEXELS * 4);
    for (let index = 0; index < pack.count; index++) {
      const at = (item + index) * STYLE_TEXELS * 4;
      styles.data[at + 14] += segment;
      // A binned area's first bin.
      if (styles.data[at + 8] === KIND.area && styles.data[at + 16] > 0)
        styles.data[at + 19] += bin;
    }
    segments.data.set(pack.segments, segment * 4);
    bins.data.set(pack.bins, bin * 4);
    item += pack.count;
    segment += pack.segments.length / 4;
    bin += pack.bins.length / 4;
  }
  const frames = texelStorage(count * TEXELS);
  const grid = {
    width: GRID_COLS,
    height: GRID_ROWS,
    data: new Float32Array(GRID_COLS * GRID_ROWS * 4),
  };
  let candidates = texelStorage(1);
  const counts = new Uint32Array(GRID_COLS * GRID_ROWS);
  const offsets = new Uint32Array(counts.length);
  const cursor = new Uint32Array(counts.length);
  const ranges = new Int32Array(count * 4);
  const viewFrame = new Float64Array(12);
  const box = new Float64Array(4);
  const lastView = new Float64Array(16).fill(Number.NaN);
  const lastProjection = new Float64Array(16).fill(Number.NaN);
  let lastWidth = 0;
  let lastHeight = 0;
  const clampTo = (value, max) => Math.min(max - 1, Math.max(0, value));

  return {
    count,
    styles,
    segments,
    bins,
    frames,
    grid,
    get candidates() {
      return candidates;
    },
    /** True when the frames, grid or candidates changed (upload them). */
    update(view, projection, width, height) {
      let changed = width !== lastWidth || height !== lastHeight;
      for (let index = 0; index < 16 && !changed; index++)
        changed =
          view[index] !== lastView[index] ||
          projection[index] !== lastProjection[index];
      if (!changed) return false;
      lastView.set(view);
      lastProjection.set(projection);
      lastWidth = width;
      lastHeight = height;
      const m = view;
      counts.fill(0);
      for (let index = 0; index < count; index++) {
        const f = index * 13;
        // Centre with the translation, axes without; float64 until here.
        for (let axis = 0; axis < 4; axis++) {
          const x = frames64[f + axis * 3];
          const y = frames64[f + axis * 3 + 1];
          const z = frames64[f + axis * 3 + 2];
          const translate = axis === 0 ? 1 : 0;
          viewFrame[axis * 3] =
            m[0] * x + m[4] * y + m[8] * z + translate * m[12];
          viewFrame[axis * 3 + 1] =
            m[1] * x + m[5] * y + m[9] * z + translate * m[13];
          viewFrame[axis * 3 + 2] =
            m[2] * x + m[6] * y + m[10] * z + translate * m[14];
        }
        const t = index * TEXELS * 4;
        frames.data.set(viewFrame.subarray(0, 3), t);
        frames.data[t + 3] = frames64[f + 12];
        frames.data.set(viewFrame.subarray(3, 6), t + 4);
        frames.data.set(viewFrame.subarray(6, 9), t + 8);
        frames.data.set(viewFrame.subarray(9, 12), t + 12);
        const v = index * 4;
        // The item's extent in its plane and its padding in pixels, for
        // the shader's early rejection.
        frames.data[t + 7] = volumes[v];
        frames.data[t + 11] = volumes[v + 3];
        const distance = Math.hypot(viewFrame[0], viewFrame[1], viewFrame[2]);
        // Heights relative to the plane's origin on the ellipsoid; the
        // plane dips under the curve by r²/2R at the item's edge.
        const low = heights[index * 2];
        const known = Number.isFinite(low);
        const dip = (volumes[v] * volumes[v]) / (2 * frames64[f + 12]);
        clipBounds(
          viewFrame,
          volumes[v],
          known
            ? low - lodMargin(distance) - dip * 1.1
            : Math.max(volumes[v + 1], nearFloor(distance)),
          known
            ? heights[index * 2 + 1] + TILE_HEADROOM_M + lodMargin(distance)
            : volumes[v + 2],
          projection,
          box,
        );
        const r = index * 4;
        const valid = box[0] <= 1;
        if (!valid) {
          ranges[r] = -1;
          continue;
        }
        const padX = (2 * volumes[v + 3]) / Math.max(1, width);
        const padY = (2 * volumes[v + 3]) / Math.max(1, height);
        ranges[r] = clampTo(
          Math.floor(((box[0] - padX) * 0.5 + 0.5) * GRID_COLS),
          GRID_COLS,
        );
        ranges[r + 1] = clampTo(
          Math.floor(((box[1] - padY) * 0.5 + 0.5) * GRID_ROWS),
          GRID_ROWS,
        );
        ranges[r + 2] = clampTo(
          Math.floor(((box[2] + padX) * 0.5 + 0.5) * GRID_COLS),
          GRID_COLS,
        );
        ranges[r + 3] = clampTo(
          Math.floor(((box[3] + padY) * 0.5 + 0.5) * GRID_ROWS),
          GRID_ROWS,
        );
        for (let y = ranges[r + 1]; y <= ranges[r + 3]; y++)
          for (let x = ranges[r]; x <= ranges[r + 2]; x++)
            counts[y * GRID_COLS + x]++;
      }
      let total = 0;
      for (let cell = 0; cell < counts.length; cell++) {
        offsets[cell] = total;
        cursor[cell] = total;
        total += counts[cell];
        grid.data[cell * 4] = offsets[cell];
        grid.data[cell * 4 + 1] = counts[cell];
      }
      if (candidates.data.length / 4 < total)
        candidates = texelStorage(
          Math.max(total, (candidates.data.length / 4) * 2),
        );
      // Items enter each cell in draw order.
      for (let index = 0; index < count; index++) {
        const r = index * 4;
        if (ranges[r] < 0) continue;
        for (let y = ranges[r + 1]; y <= ranges[r + 3]; y++)
          for (let x = ranges[r]; x <= ranges[r + 2]; x++)
            candidates.data[cursor[y * GRID_COLS + x]++ * 4] = index;
      }
      return true;
    },
  };
}
