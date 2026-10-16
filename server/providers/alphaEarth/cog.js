import { fromUrl } from 'geotiff';

import { ALPHA_EARTH_BANDS } from './constants.js';
import { cogUrl } from './catalog.js';

/** Open GeoTIFF handles kept per process; each costs a header round trip. */
const MAX_OPEN_COGS = 32;

/**
 * Range-request reader for the mirror's COGs. Keeps a small LRU of opened
 * files so repeated requests over the same area skip the header fetch.
 */
export function createCogReader({ open = (url) => fromUrl(url) } = {}) {
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
