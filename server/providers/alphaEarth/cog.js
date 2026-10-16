import { fromUrl } from 'geotiff';

import { ALPHA_EARTH_BANDS } from './constants.js';
import { cogUrl } from './catalog.js';

/** Open GeoTIFF handles kept per process; each costs a header round trip. */
const MAX_OPEN_COGS = 32;
/** One retry after a network failure; HTTP and shape errors are final. */
const RETRY_DELAY_MS = 1_000;

/** Node's fetch rejects a dropped connection with a TypeError ("fetch failed"). */
const isTransient = (err) =>
  err instanceof TypeError ||
  ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(
    err?.cause?.code ?? err?.code,
  );

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Range-request reader for the mirror's COGs. Keeps a small LRU of opened
 * files so repeated requests over the same area skip the header fetch.
 */
export function createCogReader({
  open = (url) => fromUrl(url),
  retryDelayMs = RETRY_DELAY_MS,
} = {}) {
  /** @type {Map<string, Promise<object>>} */
  const handles = new Map();

  function handle(url) {
    let entry = handles.get(url);
    if (entry) {
      handles.delete(url);
      handles.set(url, entry);
      return entry;
    }
    entry = Promise.resolve()
      .then(() => open(url))
      .catch((err) => {
        handles.delete(url);
        throw err;
      });
    handles.set(url, entry);
    while (handles.size > MAX_OPEN_COGS) {
      handles.delete(handles.keys().next().value);
    }
    return entry;
  }

  /**
   * Read one window of all 64 bands, pixel-interleaved.
   *
   * @param {object} record - catalog record (see catalog.js)
   * @param {number} level - overview level (0 = 10 m)
   * @param {{x0:number,y0:number,x1:number,y1:number}} window - file pixels;
   *   rows count from the south edge because the files are bottom-up
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<Int8Array>}
   */
  async function read(record, level, window, { signal } = {}) {
    try {
      return await readOnce(record, level, window, signal);
    } catch (err) {
      if (signal?.aborted || !isTransient(err)) throw err;
      // A failed open already left the LRU; a failed read reopens the file.
      handles.delete(cogUrl(record));
      await delay(retryDelayMs, signal);
      return readOnce(record, level, window, signal);
    }
  }

  async function readOnce(record, level, window, signal) {
    const tiff = await handle(cogUrl(record));
    const count = await tiff.getImageCount();
    if (level >= count) throw new Error(`overview ${level} not present`);
    const image = await tiff.getImage(level);
    if (image.getSamplesPerPixel() !== ALPHA_EARTH_BANDS) {
      throw new Error('unexpected band count');
    }
    const data = await image.readRasters({
      window: [window.x0, window.y0, window.x1, window.y1],
      interleave: true,
      pool: null,
      signal,
    });
    const expected =
      (window.x1 - window.x0) * (window.y1 - window.y0) * ALPHA_EARTH_BANDS;
    if (!(data instanceof Int8Array) || data.length !== expected) {
      throw new Error('unexpected raster shape');
    }
    return data;
  }

  return { read };
}
