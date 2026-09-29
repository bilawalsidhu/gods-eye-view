import { readResponseBytesCapped } from '../../sources/httpBody.js';
import { weatherTileUrl, WEATHER_IMAGE_SIZES } from './source.js';
import { decodeInfraredImage } from './infraredImage.js';

export const MERCATOR_LATITUDE = 85.0511;
export const RAINVIEWER_BOUNDS = Object.freeze({
  west: -180,
  south: -MERCATOR_LATITUDE,
  east: 180,
  north: MERCATOR_LATITUDE,
});

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Clamp a non-wrapping geographic window to the Mercator domain. */
export function mercatorBbox(bbox = RAINVIEWER_BOUNDS) {
  const box = { ...bbox };
  if (
    !['west', 'south', 'east', 'north'].every((key) =>
      Number.isFinite(box[key]),
    ) ||
    box.west < -180 ||
    box.east > 180 ||
    box.west >= box.east
  )
    throw new Error('Invalid Mercator window');
  box.south = Math.max(-MERCATOR_LATITUDE, box.south);
  box.north = Math.min(MERCATOR_LATITUDE, box.north);
  if (box.south >= box.north) throw new Error('Invalid Mercator window');
  return box;
}

/** Normalized Web Mercator row, increasing southward. */
export function latitudeToMercatorRow(latitude) {
  const radians =
    (Math.max(-MERCATOR_LATITUDE, Math.min(MERCATOR_LATITUDE, latitude)) *
      Math.PI) /
    180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
}

/** Latitude of a normalized Web Mercator row. */
export function mercatorRowToLatitude(row) {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * row))) * 180) / Math.PI;
}

/** Inclusive XYZ tile range; an exact east/south edge does not add a tile. */
export function mercatorTileRange(bbox, z) {
  const b = mercatorBbox(bbox);
  const n = 2 ** z;
  const edge = (value) => Math.max(0, Math.min(n - 1, value));
  const west = edge(Math.floor(((b.west + 180) / 360) * n));
  const east = edge(Math.ceil(((b.east + 180) / 360) * n) - 1);
  const north = edge(Math.floor(latitudeToMercatorRow(b.north) * n));
  const south = edge(Math.ceil(latitudeToMercatorRow(b.south) * n) - 1);
  return {
    west,
    east,
    north,
    south,
    count: (east - west + 1) * (south - north + 1),
  };
}

/** Highest permitted zoom that fits both the tile and horizontal pixel budgets. */
export function chooseMercatorZoom(bbox, size, maxTiles = 24) {
  const b = mercatorBbox(bbox);
  for (let z = 7; z >= 0; z--) {
    if (
      mercatorTileRange(b, z).count <= maxTiles &&
      ((b.east - b.west) / 360) * 256 * 2 ** z <= 2 * size.width
    )
      return z;
  }
  throw new Error('Mercator image budget too small');
}

/** Source pixel row at the centre of an equirectangular output row. */
export function mercatorSourceRow(row, height, bbox, z, tileNorth) {
  const latitude =
    bbox.north - ((row + 0.5) / height) * (bbox.north - bbox.south);
  return latitudeToMercatorRow(latitude) * 256 * 2 ** z - tileNorth * 256;
}

/** Compose bounded same-origin XYZ tiles and reproject with one strip per row. */
export async function composeMercatorImage({
  product = 'radar-global',
  time,
  bbox = RAINVIEWER_BOUNDS,
  size = WEATHER_IMAGE_SIZES['radar-global'],
  fetchImpl = (...args) => globalThis.fetch(...args),
  createCanvas = () => document.createElement('canvas'),
  decodeImage = decodeInfraredImage,
  signal = new AbortController().signal,
  maxTiles = 24,
  concurrency = 6,
  sleep = wait,
}) {
  signal.throwIfAborted();
  if (
    product !== 'radar-global' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isInteger(maxTiles) ||
    maxTiles < 1 ||
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > 4096 ||
    size.height > 2048
  )
    throw new Error('Invalid Mercator image options');
  const box = mercatorBbox(bbox ?? RAINVIEWER_BOUNDS);
  const z = chooseMercatorZoom(box, size, maxTiles);
  const range = mercatorTileRange(box, z);
  const mosaic = createCanvas();
  mosaic.width = (range.east - range.west + 1) * 256;
  mosaic.height = (range.south - range.north + 1) * 256;
  const context = mosaic.getContext('2d');
  const template = weatherTileUrl(product, time);
  const tiles = [];
  for (let y = range.north; y <= range.south; y++)
    for (let x = range.west; x <= range.east; x++) tiles.push({ x, y });
  let next = 0,
    loaded = 0,
    decodeMs = 0;
  async function worker() {
    while (next < tiles.length && !signal.aborted) {
      const { x, y } = tiles[next++];
      let image;
      try {
        const url = template
          .replace('{z}', z)
          .replace('{x}', x)
          .replace('{y}', y);
        let response = await fetchImpl(url, { signal });
        // The proxy meters RainViewer; wait out a 429 rather than baking a hole
        // into a frame that is then cached.
        for (let retry = 0; response.status === 429 && retry < 3; retry++) {
          await response.body?.cancel();
          const seconds = Number(response.headers.get('retry-after'));
          await sleep(
            Math.min(
              15,
              Number.isFinite(seconds) && seconds > 0 ? seconds : 2,
            ) * 1000,
            signal,
          );
          response = await fetchImpl(url, { signal });
        }
        if (!response.ok) throw new Error('Weather tile unavailable');
        const bytes = await readResponseBytesCapped(response, 1024 * 1024);
        signal.throwIfAborted();
        const started = performance.now();
        image = await decodeImage(
          new Blob([bytes], { type: 'image/png' }),
          signal,
        );
        signal.throwIfAborted();
        if (image.width !== 256 || image.height !== 256)
          throw new Error('Invalid weather tile dimensions');
        context.drawImage(
          image,
          (x - range.west) * 256,
          (y - range.north) * 256,
        );
        decodeMs += performance.now() - started;
        loaded++;
      } catch {
        // Missing tiles stay transparent; cancellation is checked after all workers settle.
      } finally {
        image?.close?.();
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tiles.length) }, worker),
  );
  signal.throwIfAborted();
  if (!loaded) throw new Error('Weather tiles unavailable');
  const texture = createCanvas();
  texture.width = size.width;
  texture.height = size.height;
  const output = texture.getContext('2d');
  const scale = 256 * 2 ** z;
  const sx = ((box.west + 180) / 360) * scale - range.west * 256;
  const sw = ((box.east - box.west) / 360) * scale;
  const started = performance.now();
  for (let row = 0; row < size.height; row++) {
    const sy = Math.max(
      0,
      Math.min(
        mosaic.height - 1,
        mercatorSourceRow(row, size.height, box, z, range.north) - 0.5,
      ),
    );
    output.drawImage(mosaic, sx, sy, sw, 1, 0, row, size.width, 1);
  }
  return { texture, decodeMs: decodeMs + performance.now() - started };
}
