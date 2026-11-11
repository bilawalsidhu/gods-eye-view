import { MASK_KEEP_SHARE, MASK_SAMPLE_PX } from './policy.js';

/** More than any real tile holds (a dense z13 tile has ~4,700 segments). */
export const MAX_TILE_SEGMENTS = 20_000;
/** A chained line stops growing here and the next one starts. */
export const MAX_LINE_POINTS = 5_000;

/**
 * The way segments of a KartaView coverage tile
 * (`{lines: [{track: [{lat, lng}]}]}`), as [lon, lat] point lists. Lines
 * carry no sequence, date or projection: a filter thins them through a mask
 * (see `maskedSegments`).
 * @param {object} payload
 * @returns {Array<Array<[number, number]>>}
 */
export function tileSegments(payload) {
  // Not cached as empty: an unreadable tile is asked for again.
  if (!Array.isArray(payload?.lines))
    throw new Error('KartaView sent an unreadable coverage tile');
  const segments = [];
  for (const line of payload.lines) {
    if (segments.length >= MAX_TILE_SEGMENTS) break;
    const points = [];
    for (const point of Array.isArray(line?.track) ? line.track : []) {
      const lon = Number(point?.lng);
      const lat = Number(point?.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const last = points[points.length - 1];
      if (last && last[0] === lon && last[1] === lat) continue;
      points.push([lon, lat]);
    }
    if (points.length >= 2) segments.push(points);
  }
  return segments;
}

/**
 * Segments chained into line records for the shared coverage: segments
 * that meet end to start are joined, which cuts the line count about
 * fourfold.
 * @param {Array<Array<[number, number]>>} segments
 * @param {{x: number, y: number, z: number}} address
 * @returns {{sequences: Array<{id: string, parts: Array<Array<[number, number]>>, capturedAt: number, isPano: boolean}>}}
 */
export function chainSegments(segments, { x, y, z }) {
  const key = ([lon, lat]) => `${lon},${lat}`;
  const startingAt = new Map();
  segments.forEach((segment, index) => {
    const at = key(segment[0]);
    const list = startingAt.get(at);
    if (list) list.push(index);
    else startingAt.set(at, [index]);
  });
  const used = new Uint8Array(segments.length);
  // Per start point, how far its list has been used: each segment is looked
  // at once, so a tile of segments sharing one point stays linear.
  const cursor = new Map();
  const nextFrom = (point) => {
    const at = key(point);
    const list = startingAt.get(at);
    if (!list) return undefined;
    let i = cursor.get(at) ?? 0;
    while (i < list.length && used[list[i]]) i++;
    cursor.set(at, i);
    return list[i];
  };
  const sequences = [];
  segments.forEach((segment, index) => {
    if (used[index]) return;
    used[index] = 1;
    const chain = [...segment];
    for (;;) {
      const next = nextFrom(chain[chain.length - 1]);
      if (next === undefined) break;
      // Full: the segment starts the next line instead.
      if (chain.length + segments[next].length - 1 > MAX_LINE_POINTS) break;
      used[next] = 1;
      chain.push(...segments[next].slice(1));
    }
    sequences.push({
      id: `${z}/${x}/${y}/${sequences.length}`,
      parts: [chain],
      capturedAt: 0,
      isPano: false,
    });
  });
  return { sequences };
}

/** Decode a KartaView coverage tile into the shared coverage's line records. */
export function decodeCoverageTile(payload, address) {
  return chainSegments(tileSegments(payload), address);
}

/**
 * The segments a filtered PNG tile of the same address draws over. The PNG
 * draws the same ways a few pixels wide (on a transparent ground): a
 * segment is kept when at least half the points sampled along it have a
 * drawn pixel within one pixel. Segments either lie on it or miss it
 * almost entirely (Jakarta, 360° only: 332 of 1,041 kept, 676 missed, 33
 * between). A segment with no point on the tile is not this tile's to keep.
 * @param {Array<Array<[number, number]>>} segments
 * @param {{width: number, height: number, alpha: ArrayLike<number>}} mask  one alpha byte per pixel
 * @param {{x: number, y: number, z: number}} address
 */
export function maskedSegments(segments, mask, { x, y, z }) {
  const { width, height, alpha } = mask;
  const n = 2 ** z;
  const toPixel = ([lon, lat]) => {
    const sin = Math.sin((lat * Math.PI) / 180);
    const my = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    return [(((lon + 180) / 360) * n - x) * width, (my * n - y) * height];
  };
  const drawnNear = (px, py) => {
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const X = cx + dx;
        const Y = cy + dy;
        if (X < 0 || Y < 0 || X >= width || Y >= height) continue;
        if (alpha[Y * width + X] > 0) return true;
      }
    return false;
  };
  return segments.filter((segment) => {
    let on = 0;
    let tested = 0;
    let [ax, ay] = toPixel(segment[0]);
    for (let i = 1; i < segment.length; i++) {
      const [bx, by] = toPixel(segment[i]);
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(bx - ax, by - ay) / MASK_SAMPLE_PX),
      );
      // Each point once: a segment's next stretch starts where this one ends.
      for (let j = i === 1 ? 0 : 1; j <= steps; j++) {
        const px = ax + ((bx - ax) * j) / steps;
        const py = ay + ((by - ay) * j) / steps;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        tested++;
        if (drawnNear(px, py)) on++;
      }
      ax = bx;
      ay = by;
    }
    return tested > 0 && on / tested >= MASK_KEEP_SHARE;
  });
}

/**
 * A PNG mask's alpha, one byte per pixel, decoded off the main thread
 * where the browser can.
 * @param {Uint8Array} bytes  the PNG
 * @returns {Promise<{width: number, height: number, alpha: Uint8Array}>}
 */
export async function readMaskImage(bytes) {
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: 'image/png' }),
  );
  try {
    const { width, height } = bitmap;
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, width, height).data;
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    return { width, height, alpha };
  } finally {
    bitmap.close?.();
  }
}
