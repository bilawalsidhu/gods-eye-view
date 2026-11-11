// A corridor set as Navara's ground pass draws it (pack.js), without three:
// the set's lines, cut into pieces of at most MAX_PIECE_DEG along their
// great circles, fall into a tree of longitude/latitude tiles of at most
// TILE_PIECES pieces each. A tile is one pass item: a gnomonic plane of its
// own, the pieces that come near it as segments in that plane, and a
// pyramid of square bins over it. Each bin of level z (2^z times the finest
// bin) lists the runs of segments, item by item in draw order, that reach
// within a margin of it: MARGIN_RATIO bins for the set's thinnest corridor,
// more for a wider one, plus its width in metres. A pixel takes the tile
// whose longitude/latitude cell holds its ground (tested once per pixel in
// world space, so neighbouring tiles never both draw it), the finest level
// whose margin covers its widest reach, and tests only its bin's runs.

import * as geo from '../../../geo/index.js';

const { cartesian3, ellipsoid } = geo;

const DEG = Math.PI / 180;
/** Reveal fraction within a packed corridor item. */
export const REVEAL_OFFSET = 20;

/** Pieces a tile holds before it splits. */
export const TILE_PIECES = 20000;
/** A piece's longest arc, degrees. */
export const MAX_PIECE_DEG = 0.5;
// A tile's longest side, degrees: its plane stays precise in float32 and
// its meridians less than 180° apart.
const MAX_TILE_DEG = 20;
// A tile this small (metres) never splits: its pieces share a few metres.
const MIN_TILE_M = 50;
/** A bin's margin, in bins at its level, for the set's thinnest corridor. */
export const MARGIN_RATIO = 0.5;
// Runs the finest level holds per piece of the tile, about: it sets the
// finest bin (smaller bins test fewer segments a pixel and hold more runs).
const RUN_BUDGET = 2;
// The coarsest level has at most this many bins across; its margin bounds
// how far a tile reaches into its neighbours.
const TOP_ACROSS = 8;
// The finest level has at most this many.
const MAX_ACROSS = 128;
/** Slack for the pixel's world position, metres. */
export const EPSILON_M = 4;
// Segments of one line a run spans over: fewer, longer runs.
const RUN_GAP = 2;
const METRES_PER_DEG = ellipsoid.WGS84.maximumRadius * DEG;
const E2 =
  1 - (ellipsoid.WGS84.minimumRadius / ellipsoid.WGS84.maximumRadius) ** 2;

/** Item looks as the shader reads them: glow, pulse and dash bits. */
export const LOOK = Object.freeze({ glow: 1, pulse: 2, dash: 4, pattern: 8 });
/** RGBA32F texels per corridor item. */
export const ITEM_TEXELS = 7;

const wrap180 = (degrees) => degrees - 360 * Math.round(degrees / 360);
const geodetic = (latcDeg) =>
  Math.abs(latcDeg) >= 90
    ? latcDeg
    : Math.atan(Math.tan(latcDeg * DEG) / (1 - E2)) / DEG;

/** One item's look: colour, widths, glow/pulse, dash and reveal. */
function itemTexels(item, lengthM) {
  const { glow, pulse, dash, pattern } = item.animation ?? {};
  const flags =
    (glow ? LOOK.glow : 0) |
    (pulse ? LOOK.pulse : 0) |
    (dash ? LOOK.dash : 0) |
    (pattern ? LOOK.pattern : 0);
  return [
    ...item.fill,
    item.animation?.backing?.widthPx ?? item.widthPx ?? 0,
    item.widthM ?? 0,
    lengthM,
    flags,
    glow?.power ?? 0,
    glow?.taper ?? 1,
    pulse ? pulse.periodMs / 1000 : 1,
    pulse?.min ?? 1,
    pulse?.max ?? 1,
    dash?.cells ?? 0,
    dash?.duty ?? 0.5,
    dash?.speed ?? 0,
    dash?.gapAlpha ?? 0,
    dash?.emission ?? 0,
    pattern?.lengthPx ?? 0,
    pattern?.pattern ?? 0,
    1,
    item.widthPx / (item.animation?.backing?.widthPx ?? item.widthPx) || 1,
    0,
    0,
    ...(item.animation?.backing?.color ?? [0, 0, 0, 0]),
  ];
}

// Every item's line as pieces: unit directions from the Earth's centre
// (a plane through the centre holds each piece), their ends in longitude
// and geocentric latitude, and their place along the line in metres.
function piecesOf(items) {
  const item = [];
  const index = [];
  const ends = [];
  const lonLat = [];
  const along = [];
  const lengths = [];
  const lineLengths = [];
  const point = cartesian3.create();
  items.forEach((entry, itemIndex) => {
    const flat = entry.path;
    const count = flat.length / 2;
    const directions = [];
    const surface = [];
    for (let k = 0; k < count; k++) {
      cartesian3.fromDegrees(flat[k * 2], flat[k * 2 + 1], 0, undefined, point);
      surface.push([point.x, point.y, point.z]);
      const length = Math.hypot(point.x, point.y, point.z);
      directions.push([point.x / length, point.y / length, point.z / length]);
    }
    let total = 0;
    let piece = 0;
    for (let k = 0; k + 1 < count; k++) {
      const a = directions[k];
      const b = directions[k + 1];
      const angle = Math.acos(
        Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])),
      );
      const steps = Math.max(
        1,
        Math.ceil(angle / (MAX_PIECE_DEG * DEG) - 1e-9),
      );
      const chord = Math.hypot(
        surface[k + 1][0] - surface[k][0],
        surface[k + 1][1] - surface[k][1],
        surface[k + 1][2] - surface[k][2],
      );
      // Along the great circle from a to b (the plane through both and
      // the centre), in equal steps.
      const sin = Math.sin(angle);
      const between = (t) => {
        if (sin < 1e-12) return a;
        const wa = Math.sin((1 - t) * angle) / sin;
        const wb = Math.sin(t * angle) / sin;
        return [
          wa * a[0] + wb * b[0],
          wa * a[1] + wb * b[1],
          wa * a[2] + wb * b[2],
        ];
      };
      let from = a;
      for (let step = 1; step <= steps; step++) {
        const to = step === steps ? b : between(step / steps);
        item.push(itemIndex);
        index.push(piece++);
        ends.push(...from, ...to);
        const lonA = Math.atan2(from[1], from[0]) / DEG;
        const lonB = Math.atan2(to[1], to[0]) / DEG;
        lonLat.push(
          lonA,
          Math.asin(Math.max(-1, Math.min(1, from[2]))) / DEG,
          lonA + wrap180(lonB - lonA),
          Math.asin(Math.max(-1, Math.min(1, to[2]))) / DEG,
        );
        along.push(total + (chord * (step - 1)) / steps);
        lengths.push(chord / steps);
        from = to;
      }
      total += chord;
    }
    lineLengths.push(total);
  });
  return {
    count: item.length,
    item: Int32Array.from(item),
    index: Int32Array.from(index),
    ends: Float64Array.from(ends),
    lonLat: Float64Array.from(lonLat),
    along: Float64Array.from(along),
    lengths: Float64Array.from(lengths),
    lineLengths,
  };
}

// The middle of the widest gap between the pieces' longitudes: the set's
// longitudes run from there round to there.
function seamOf(lonLat, count) {
  const lons = new Float64Array(count * 2);
  for (let piece = 0; piece < count; piece++) {
    lons[piece * 2] = wrap180(lonLat[piece * 4]);
    lons[piece * 2 + 1] = wrap180(lonLat[piece * 4 + 2]);
  }
  lons.sort();
  let seam = lons[0] - 180;
  let widest = -1;
  for (let k = 0; k < lons.length; k++) {
    const next = k + 1 < lons.length ? lons[k + 1] : lons[0] + 360;
    if (next - lons[k] > widest) {
      widest = next - lons[k];
      seam = (lons[k] + next) / 2;
    }
  }
  return seam;
}

// The longest east-west and north-south sides of a rectangle, metres.
function sidesM(rect) {
  const nearest = Math.min(
    89.9,
    rect.south <= 0 && rect.north >= 0
      ? 0
      : Math.min(Math.abs(rect.south), Math.abs(rect.north)),
  );
  return [
    (rect.east - rect.west) * METRES_PER_DEG * Math.cos(nearest * DEG),
    (rect.north - rect.south) * METRES_PER_DEG,
  ];
}

/**
 * Whether a piece's padded bounds come within `metres` of `rect`, the
 * metres as degrees of longitude by `lonPerLat` (rect's coldest latitude
 * and the farthest margin from it).
 */
function near(boxes, piece, rect, metres, lonPerLat) {
  const b = piece * 4;
  const dLat = metres / METRES_PER_DEG;
  if (boxes[b + 1] > rect.north + dLat || boxes[b + 3] < rect.south - dLat)
    return false;
  const dLon = dLat * lonPerLat;
  const west = rect.west - dLon;
  const east = rect.east + dLon;
  return (
    (boxes[b] <= east && boxes[b + 2] >= west) ||
    (boxes[b] + 360 <= east && boxes[b + 2] + 360 >= west) ||
    (boxes[b] - 360 <= east && boxes[b + 2] - 360 >= west)
  );
}

// Degrees of longitude per degree of latitude near `rect`, `metres` from it.
function lonPerLatNear(rect, metres) {
  const coldest = Math.min(
    89.9,
    Math.max(Math.abs(rect.south), Math.abs(rect.north)) +
      metres / METRES_PER_DEG,
  );
  return 1 / Math.max(1e-3, Math.cos(coldest * DEG));
}

/**
 * The tiles of a corridor set: { pieces (piecesOf, with each piece's
 * padded bounds in `boxes`: west, south, east, north), tiles }. A tile is
 * { west, south, east, north } (longitude, geocentric latitude, degrees;
 * the tiles split the set's bounds and a border round them), `own` (the
 * pieces in it) and `near` (those that may come within their margin of
 * it). `reachOf(item)` is [half width in pixels + 0.5, half width in
 * metres]; `reference` the set's least pixel reach; `tilePieces` (a test
 * seam) the pieces a tile holds before it splits.
 */
export function tileCorridors(
  items,
  reachOf,
  reference,
  tilePieces = TILE_PIECES,
) {
  const pieces = piecesOf(items);
  const { count, lonLat } = pieces;
  if (!count) return { pieces, tiles: [] };
  const seam = seamOf(lonLat, count);
  const boxes = new Float64Array(count * 4);
  // A piece's margin per metre of a tile's side, and its fixed metres.
  const perSide = new Float64Array(count);
  const fixed = new Float64Array(count);
  // Its pixel reach over the reference's, and its half width in metres.
  const ratio = new Float64Array(count);
  const metres = new Float64Array(count);
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let piece = 0; piece < count; piece++) {
    const lonA = seam + ((((lonLat[piece * 4] - seam) % 360) + 360) % 360);
    const lonB = lonA + (lonLat[piece * 4 + 2] - lonLat[piece * 4]);
    const latA = lonLat[piece * 4 + 1];
    const latB = lonLat[piece * 4 + 3];
    // A great circle bows off the straight line between its ends in
    // longitude and latitude; pad by a bound of that.
    const span = Math.hypot(
      (lonB - lonA) * Math.cos(((latA + latB) / 2) * DEG),
      latB - latA,
    );
    const steepest = Math.min(89, Math.max(Math.abs(latA), Math.abs(latB)));
    const bow =
      (((span * DEG) ** 2 / 8 / DEG) * (1 + Math.tan(steepest * DEG)) * 2) /
        Math.max(0.02, Math.cos(steepest * DEG)) +
      1e-7;
    const box = [
      Math.min(lonA, lonB) - bow,
      Math.max(-90, Math.min(latA, latB) - bow),
      Math.max(lonA, lonB) + bow,
      Math.min(90, Math.max(latA, latB) + bow),
    ];
    boxes.set(box, piece * 4);
    const [px, m] = reachOf(items[pieces.item[piece]]);
    ratio[piece] = px / reference;
    metres[piece] = m;
    perSide[piece] = 1.1 * MARGIN_RATIO * ratio[piece];
    fixed[piece] = m + 2 * EPSILON_M;
    west = Math.min(west, box[0]);
    south = Math.min(south, box[1]);
    east = Math.max(east, box[2]);
    north = Math.max(north, box[3]);
  }
  Object.assign(pieces, { boxes, ratio, metres });
  // The tiles split the set's bounds; a tile on an edge of them also takes
  // every pixel beyond that edge (its side is open), as if the pixel were
  // moved onto the bounds.
  const root = {
    west,
    south,
    east: Math.max(east, west + 1e-9),
    north: Math.max(north, south + 1e-9),
    open: { west: true, south: true, east: true, north: true },
  };
  let widestFixed = 0;
  let widestPerSide = 0;
  for (let piece = 0; piece < count; piece++) {
    widestFixed = Math.max(widestFixed, fixed[piece]);
    widestPerSide = Math.max(widestPerSide, perSide[piece]);
  }
  const tiles = [];
  const split = (rect, own, nearby) => {
    const lonSpan = rect.east - rect.west;
    const latSpan = rect.north - rect.south;
    const [widthM, heightM] = sidesM(rect);
    const tooWide = lonSpan > MAX_TILE_DEG || latSpan > MAX_TILE_DEG;
    if (
      !tooWide &&
      (own.length <= tilePieces || Math.max(widthM, heightM) < 2 * MIN_TILE_M)
    ) {
      // A tile no line reaches draws nothing.
      if (nearby.length) tiles.push({ ...rect, own, near: nearby });
      return;
    }
    const alongLon = tooWide ? lonSpan >= latSpan : widthM >= heightM;
    const mid = alongLon
      ? (rect.west + rect.east) / 2
      : (rect.south + rect.north) / 2;
    const halves = alongLon
      ? [
          { ...rect, east: mid, open: { ...rect.open, east: false } },
          { ...rect, west: mid, open: { ...rect.open, west: false } },
        ]
      : [
          { ...rect, north: mid, open: { ...rect.open, north: false } },
          { ...rect, south: mid, open: { ...rect.open, south: false } },
        ];
    for (const half of halves) {
      const side = Math.max(...sidesM(half));
      const lonPerLat = lonPerLatNear(half, widestFixed + widestPerSide * side);
      split(
        half,
        own.filter((piece) => near(boxes, piece, half, 0, 1)),
        nearby.filter((piece) =>
          near(
            boxes,
            piece,
            half,
            fixed[piece] + perSide[piece] * side,
            lonPerLat,
          ),
        ),
      );
    }
  };
  const all = Array.from({ length: count }, (_, piece) => piece);
  split(root, all, all);
  return { pieces, tiles };
}

/**
 * One tile packed for the pass, in `frame`'s gnomonic plane (pack.js
 * frameAt): its region's bounds in the plane, its segments (the pieces
 * near it, item by item), its bins' runs and its levels.
 * `reachOf(item)` is the item's [half width in pixels + 0.5, half width in
 * metres]; `reference` the set's least pixel reach.
 */
export function packTile(tile, pieces, frame, reference) {
  const { project } = frame;
  // Its region in the plane, from its edges.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const STEPS = 8;
  for (let k = 0; k <= STEPS; k++) {
    const f = k / STEPS;
    for (const [lon, latc] of [
      [tile.west + f * (tile.east - tile.west), tile.south],
      [tile.west + f * (tile.east - tile.west), tile.north],
      [tile.west, tile.south + f * (tile.north - tile.south)],
      [tile.east, tile.south + f * (tile.north - tile.south)],
    ]) {
      const [x, y] = project(direction(lon, latc));
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const pad = 0.01 * Math.max(x1 - x0, y1 - y0) + EPSILON_M;
  x0 -= pad;
  y0 -= pad;
  x1 += pad;
  y1 += pad;
  const width = x1 - x0;
  const height = y1 - y0;
  // A line crosses about (1 + 2 MARGIN_RATIO) bins of the finest level a
  // bin's length along it.
  const counted = tile.own.length ? tile.own : tile.near;
  let countedLength = 0;
  for (const piece of counted) countedLength += pieces.lengths[piece];
  const size = Math.max(
    Math.max(width, height) / MAX_ACROSS,
    ((1 + 2 * MARGIN_RATIO) * countedLength) / (RUN_BUDGET * counted.length),
    1e-3,
  );
  const columns = Math.max(1, Math.ceil(width / size));
  const rows = Math.max(1, Math.ceil(height / size));
  const levels = [];
  for (let c = columns, r = rows; ; c = (c + 1) >> 1, r = (r + 1) >> 1) {
    levels.push([c, r]);
    if (Math.max(c, r) <= TOP_ACROSS || (c === 1 && r === 1)) break;
  }
  const top = levels.length - 1;
  // A piece's margin at level z: its metres, its pixel reach scaled to the
  // reference's margin, and the slack.
  const marginOf = (piece, z) => {
    return (
      pieces.metres[piece] +
      MARGIN_RATIO * size * 2 ** z * pieces.ratio[piece] +
      EPSILON_M
    );
  };
  // Every piece that comes within its coarsest margin of the tile, by item
  // and along each line.
  const rect = {
    west: tile.west,
    south: tile.south,
    east: tile.east,
    north: tile.north,
  };
  let widest = 0;
  for (const piece of tile.near)
    widest = Math.max(widest, marginOf(piece, top));
  const lonPerLat = lonPerLatNear(rect, widest);
  const { boxes } = pieces;
  const nearby = tile.near.filter((piece) =>
    near(boxes, piece, rect, marginOf(piece, top), lonPerLat),
  );
  const segments = new Float64Array(nearby.length * 4);
  nearby.forEach((piece, at) => {
    const e = piece * 6;
    const a = project([pieces.ends[e], pieces.ends[e + 1], pieces.ends[e + 2]]);
    const b = project([
      pieces.ends[e + 3],
      pieces.ends[e + 4],
      pieces.ends[e + 5],
    ]);
    segments.set([a[0] - x0, a[1] - y0, b[0] - x0, b[1] - y0], at * 4);
  });
  // Lines: consecutive segments of one item, next to each other along it.
  const line = new Int32Array(nearby.length);
  nearby.forEach((piece, at) => {
    const previous = nearby[at - 1];
    line[at] =
      at > 0 &&
      pieces.item[previous] === pieces.item[piece] &&
      pieces.index[previous] + 1 === pieces.index[piece]
        ? line[at - 1]
        : at;
  });
  const bins = [];
  const runs = [];
  const clampTo = (value, max) => Math.min(max - 1, Math.max(0, value));
  levels.forEach(([c, r], z) => {
    const binSize = size * 2 ** z;
    const counts = new Uint32Array(c * r);
    const ranges = new Int32Array(nearby.length * 4);
    const reach = new Float64Array(nearby.length);
    nearby.forEach((piece, at) => {
      const s = at * 4;
      const margin = marginOf(piece, z);
      reach[at] = margin;
      const ax = segments[s];
      const ay = segments[s + 1];
      const bx = segments[s + 2];
      const by = segments[s + 3];
      ranges[s] = clampTo(Math.floor((Math.min(ax, bx) - margin) / binSize), c);
      ranges[s + 1] = clampTo(
        Math.floor((Math.min(ay, by) - margin) / binSize),
        r,
      );
      ranges[s + 2] = clampTo(
        Math.floor((Math.max(ax, bx) + margin) / binSize),
        c,
      );
      ranges[s + 3] = clampTo(
        Math.floor((Math.max(ay, by) + margin) / binSize),
        r,
      );
    });
    // A long diagonal segment skips the bins of its box it never nears.
    const nears = (at, column, row) => {
      const s = at * 4;
      const ax = segments[s];
      const ay = segments[s + 1];
      const dx = segments[s + 2] - ax;
      const dy = segments[s + 3] - ay;
      const cx = (column + 0.5) * binSize - ax;
      const cy = (row + 0.5) * binSize - ay;
      const lengthSq = dx * dx + dy * dy;
      const t =
        lengthSq > 0
          ? Math.max(0, Math.min(1, (cx * dx + cy * dy) / lengthSq))
          : 0;
      return (
        Math.hypot(cx - t * dx, cy - t * dy) <=
        reach[at] + binSize * Math.SQRT1_2
      );
    };
    const each = (visit) => {
      for (let at = 0; at < nearby.length; at++) {
        const s = at * 4;
        const sparse =
          ranges[s + 2] - ranges[s] > 1 && ranges[s + 3] - ranges[s + 1] > 1;
        for (let row = ranges[s + 1]; row <= ranges[s + 3]; row++)
          for (let column = ranges[s]; column <= ranges[s + 2]; column++)
            if (!sparse || nears(at, column, row)) visit(row * c + column, at);
      }
    };
    each((bin) => counts[bin]++);
    const offsets = new Uint32Array(c * r + 1);
    for (let bin = 0; bin < c * r; bin++)
      offsets[bin + 1] = offsets[bin] + counts[bin];
    const entries = new Int32Array(offsets[c * r]);
    const cursor = offsets.slice(0, c * r);
    each((bin, at) => {
      entries[cursor[bin]++] = at;
    });
    for (let bin = 0; bin < c * r; bin++) {
      const start = runs.length / 4;
      let first = -1;
      let last = -1;
      const flush = () => {
        if (first < 0) return;
        const piece = nearby[first];
        runs.push(
          pieces.item[piece],
          first,
          last - first + 1,
          pieces.along[piece],
        );
      };
      for (let k = offsets[bin]; k < offsets[bin + 1]; k++) {
        const at = entries[k];
        if (first >= 0 && line[at] === line[first] && at - last <= RUN_GAP + 1)
          last = at;
        else {
          flush();
          first = last = at;
        }
      }
      flush();
      bins.push(start, runs.length / 4 - start, 0, 0);
    }
  });
  // The segments in the frame's plane, as the shader reads them.
  for (let at = 0; at < segments.length; at += 2) {
    segments[at] += x0;
    segments[at + 1] += y0;
  }
  // The widest reach of its corridors: in pixels and in metres.
  let pixels = 0;
  let metres = 0;
  for (const piece of nearby) {
    pixels = Math.max(pixels, pieces.ratio[piece] * reference);
    metres = Math.max(metres, pieces.metres[piece]);
  }
  return {
    origin: [x0, y0],
    size,
    columns,
    rows,
    top,
    pixels,
    metres,
    segments,
    runs,
    bins,
    // The plane radius the region reaches from the frame's origin.
    extent: Math.max(
      Math.hypot(x0, y0),
      Math.hypot(x1, y0),
      Math.hypot(x0, y1),
      Math.hypot(x1, y1),
    ),
  };
}

/** The unit direction at a longitude and geocentric latitude (degrees). */
export function direction(lon, latc) {
  const cosLat = Math.cos(latc * DEG);
  return [
    cosLat * Math.cos(lon * DEG),
    cosLat * Math.sin(lon * DEG),
    Math.sin(latc * DEG),
  ];
}

/** Terrain sample positions for a tile: [lon, lat geodetic, …] degrees. */
export function tileSamples(tile, pieces, limit = 48) {
  const flat = [];
  for (let k = 0; k < 9; k++) {
    const lon = tile.west + ((k % 3) / 2) * (tile.east - tile.west);
    const latc =
      tile.south + (Math.floor(k / 3) / 2) * (tile.north - tile.south);
    flat.push(wrap180(lon), geodetic(latc));
  }
  const own = tile.own.length ? tile.own : tile.near;
  const step = Math.max(1, Math.ceil(own.length / (limit - 9)));
  for (let k = 0; k < own.length; k += step) {
    const e = own[k] * 6;
    const x = pieces.ends[e];
    const y = pieces.ends[e + 1];
    const z = pieces.ends[e + 2];
    flat.push(
      Math.atan2(y, x) / DEG,
      geodetic(Math.asin(Math.max(-1, Math.min(1, z))) / DEG),
    );
  }
  return Float64Array.from(flat);
}

export { itemTexels, geodetic };
