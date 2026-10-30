import { wvsSnapshotUrl } from './model.js';

const EARTH_RADIUS_M = 6_371_008.8;
const DEFAULT_THRESHOLD = 40;
const DEFAULT_BLOCK_SIZE = 16;

const round2 = (value) => Math.round(value * 100) / 100;

function hotspotName(x, y, width, height) {
  const horizontal =
    x < width / 3 ? 'west' : x >= (2 * width) / 3 ? 'east' : '';
  const vertical =
    y < height / 3 ? 'north' : y >= (2 * height) / 3 ? 'south' : '';
  return [vertical, horizontal].filter(Boolean).join('-') || 'centre';
}

export function diffRecentImageryFrames(before, after, options = {}) {
  const width = Number(options.width);
  const height = Number(options.height);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !before ||
    !after ||
    before.length !== after.length ||
    before.length !== width * height * 4
  )
    return null;
  const threshold = Number.isFinite(options.threshold)
    ? options.threshold
    : DEFAULT_THRESHOLD;
  const blockSize =
    Number.isInteger(options.blockSize) && options.blockSize > 0
      ? options.blockSize
      : DEFAULT_BLOCK_SIZE;
  const blocks = new Map();
  let changedPixels = 0;
  let deltaSum = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const delta = Math.max(
      Math.abs(before[offset] - after[offset]),
      Math.abs(before[offset + 1] - after[offset + 1]),
      Math.abs(before[offset + 2] - after[offset + 2]),
    );
    deltaSum += delta;
    if (delta <= threshold) continue;
    changedPixels += 1;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const bx = Math.floor(x / blockSize) * blockSize;
    const by = Math.floor(y / blockSize) * blockSize;
    const key = `${bx},${by}`;
    blocks.set(key, { x: bx, y: by, count: (blocks.get(key)?.count || 0) + 1 });
  }
  const strongest = [...blocks.values()].sort(
    (a, b) => b.count - a.count || a.y - b.y || a.x - b.x,
  )[0];
  return {
    comparedPixels: width * height,
    changedPixels,
    changedPct: round2((changedPixels / (width * height)) * 100),
    meanDelta: round2(deltaSum / (width * height)),
    hotspot: strongest
      ? hotspotName(strongest.x, strongest.y, width, height)
      : null,
  };
}

export function summarizeSiteBox(box) {
  const west = Number(box?.west);
  const south = Number(box?.south);
  const east = Number(box?.east);
  const north = Number(box?.north);
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west >= east ||
    south >= north ||
    Math.abs(south) > 90 ||
    Math.abs(north) > 90
  )
    return { ok: false };
  const latSpan = ((north - south) * Math.PI) / 180;
  const lonSpan = ((east - west) * Math.PI) / 180;
  const midLat = (((north + south) / 2) * Math.PI) / 180;
  const heightM = EARTH_RADIUS_M * latSpan;
  const widthM = EARTH_RADIUS_M * lonSpan * Math.cos(midLat);
  const areaM2 = Math.abs(widthM * heightM);
  return {
    ok: areaM2 > 0,
    areaM2,
    hectares: areaM2 / 10_000,
    acres: areaM2 / 4046.8564224,
    widthM: Math.abs(widthM),
    heightM: Math.abs(heightM),
  };
}

async function browserFrame(url, _candidate, { signal } = {}) {
  const response = await fetch(url, { signal });
  if (
    !response.ok ||
    String(response.headers?.get?.('Data-Present') || '').toLowerCase() !==
      'true'
  )
    throw new Error(`Imagery unavailable (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Image comparison unavailable');
    context.drawImage(bitmap, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  } finally {
    bitmap.close?.();
  }
}

function orderedPins(snapshot) {
  const pins = [snapshot?.pins?.a, snapshot?.pins?.b].filter(
    (candidate) => candidate?.product && candidate?.day,
  );
  return pins.sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

/** Compare the current Recent Imagery A/B selection; no extra map layer. */
export async function analyzeRecentImagerySnapshot(
  snapshot,
  { loadFrame = browserFrame, signal } = {},
) {
  const [before, after] = orderedPins(snapshot);
  if (!snapshot?.box || !before || !after)
    return { ok: false, error: 'Pin two imagery days in A / B first' };
  try {
    const size = 512;
    const urls = [before, after].map((candidate) =>
      wvsSnapshotUrl({
        product: candidate.product,
        day: candidate.day,
        box: snapshot.box,
        width: size,
        height: size,
      }),
    );
    const [first, second] = await Promise.all([
      loadFrame(urls[0], before, { signal }),
      loadFrame(urls[1], after, { signal }),
    ]);
    if (first.width !== second.width || first.height !== second.height)
      return { ok: false, error: 'The imagery frames have different sizes' };
    const diff = diffRecentImageryFrames(first.data, second.data, {
      width: first.width,
      height: first.height,
    });
    if (!diff)
      return { ok: false, error: 'The imagery frames could not be compared' };
    return {
      ok: true,
      ...diff,
      before,
      after,
      site: summarizeSiteBox(snapshot.box),
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return { ok: false, error: error?.message || 'Imagery analysis failed' };
  }
}
