/**
 * Pure parsers and validators for the Bureau of Meteorology anonymous-FTP
 * radar products. Shared by the server proxy and the tests; no Cesium or
 * network access.
 *
 * Frame files are `IDR<radar><range>.T.<YYYYMMDDHHmm>.png`: a 2-3 digit radar
 * id, one range digit (1 = 512 km, 2 = 256 km, 3 = 128 km, 4 = 64 km) and the
 * UTC observation time. The directory also holds other products
 * (`IDR64I.T....png` and similar) that this module deliberately ignores.
 */

/** Product id: `IDR` + 2-3 digit radar id + one range digit, e.g. `IDR643`. */
export const BOM_PRODUCT_PATTERN = /^IDR(\d{2,3})([1-4])$/;
/** Frame file name, strictly; nothing else is ever requested upstream. */
export const BOM_FRAME_PATTERN = /^IDR(\d{2,3})([1-4])\.T\.(\d{12})\.png$/;

/** Radar range in kilometres by the product's range digit. */
export const BOM_RANGE_KM = Object.freeze({ 1: 512, 2: 256, 3: 128, 4: 64 });

/** Frames kept per product when parsing the (large, national) listing. */
export const BOM_LISTING_KEEP = 30;
/** Frames the client animates. */
export const BOM_LOOP_FRAMES = 12;

/** Whether `value` is a well-formed product id (`IDR643`). */
export function isBomProduct(value) {
  return typeof value === 'string' && BOM_PRODUCT_PATTERN.test(value);
}

/** Whether `value` is a well-formed frame file name. */
export function isBomFrameFile(value) {
  return typeof value === 'string' && BOM_FRAME_PATTERN.test(value);
}

/** UTC epoch milliseconds for `YYYYMMDDHHmm`, or null for an impossible date. */
export function parseBomFrameTime(digits) {
  if (typeof digits !== 'string' || !/^\d{12}$/.test(digits)) return null;
  const [year, month, day, hour, minute] = [
    digits.slice(0, 4),
    digits.slice(4, 6),
    digits.slice(6, 8),
    digits.slice(8, 10),
    digits.slice(10, 12),
  ].map(Number);
  const time = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(time);
  // Date.UTC rolls 13 months or 31 February over; the file name must not.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  )
    return null;
  return time;
}

/**
 * Parse one frame file name.
 * @param {string} name
 * @returns {{file: string, product: string, radar: string, rangeKm: number, timeMs: number}|null}
 */
export function parseBomFrameName(name) {
  const match = typeof name === 'string' ? BOM_FRAME_PATTERN.exec(name) : null;
  if (!match) return null;
  const timeMs = parseBomFrameTime(match[3]);
  if (timeMs === null) return null;
  return {
    file: name,
    product: `IDR${match[1]}${match[2]}`,
    radar: match[1],
    rangeKm: BOM_RANGE_KM[match[2]],
    timeMs,
  };
}

/**
 * Group a directory listing by product, ignoring everything that is not a
 * radar frame. Frame times are irregular (about every 5-6 minutes), so the
 * listing is the only authority for which frames exist.
 * @param {string[]} names File names from the listing.
 * @param {{keep?: number}} [options] Newest frames kept per product.
 * @returns {Map<string, Array<ReturnType<typeof parseBomFrameName>>>}
 *   Product id to its frames, oldest first.
 */
export function parseBomRadarListing(names, { keep = BOM_LISTING_KEEP } = {}) {
  const products = new Map();
  if (!Array.isArray(names)) return products;
  const seen = new Set();
  for (const name of names) {
    const frame = parseBomFrameName(name);
    if (!frame || seen.has(frame.file)) continue;
    seen.add(frame.file);
    const frames = products.get(frame.product);
    if (frames) frames.push(frame);
    else products.set(frame.product, [frame]);
  }
  for (const [product, frames] of products) {
    frames.sort((a, b) => a.timeMs - b.timeMs);
    if (frames.length > keep) products.set(product, frames.slice(-keep));
  }
  return products;
}

/** The newest `count` frames, oldest first. */
export function newestBomFrames(frames, count = BOM_LOOP_FRAMES) {
  return frames.slice(Math.max(0, frames.length - count));
}

/** Group product ids by radar id: `[{ id: '64', products: ['IDR641', ...] }]`. */
export function groupBomProductsByRadar(productIds) {
  const radars = new Map();
  for (const product of productIds) {
    const match = BOM_PRODUCT_PATTERN.exec(product);
    if (!match) continue;
    const list = radars.get(match[1]);
    if (list) list.push(product);
    else radars.set(match[1], [product]);
  }
  return [...radars]
    .map(([id, products]) => ({ id, products: products.sort() }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** Range in kilometres of a product id, or null. */
export function bomProductRangeKm(product) {
  const match =
    typeof product === 'string' ? BOM_PRODUCT_PATTERN.exec(product) : null;
  return match ? BOM_RANGE_KM[match[2]] : null;
}

const finiteIn = (value, limit) =>
  Number.isFinite(value) && Math.abs(value) <= limit;

/**
 * Parse a georeferencing `.map` file (a heading line, then `key = value`
 * lines). The four corners are south-west, north-west, north-east, south-east.
 * The image is a gnomonic projection; its bounds are the corners' lat/lon
 * extent, which misregisters by a few kilometres at the longest ranges.
 * @param {string} text
 * @returns {{name: string|null, rangeKm: number|null, projection: string|null,
 *   center: {lat: number, lon: number},
 *   corners: {sw: {lat: number, lon: number}, nw: {lat: number, lon: number},
 *     ne: {lat: number, lon: number}, se: {lat: number, lon: number}},
 *   bounds: {west: number, south: number, east: number, north: number}}}
 * @throws {Error} `invalid_map` when a required value is missing or out of range.
 */
export function parseBomRadarMap(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('invalid_map');
  const values = new Map();
  let header = null;
  for (const line of text.split(/\r?\n/)) {
    const pair = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (pair) {
      const key = pair[1].toLowerCase();
      if (!values.has(key)) values.set(key, pair[2]);
    } else if (header === null && /^\s*\d+\s+\S/.test(line)) {
      header = line.trim();
    }
  }
  const number = (key) => {
    const raw = values.get(key);
    return raw !== undefined && /^[-+]?\d+(\.\d+)?$/.test(raw)
      ? Number(raw)
      : NaN;
  };
  const point = (latKey, lonKey) => {
    const lat = number(latKey);
    const lon = number(lonKey);
    if (!finiteIn(lat, 90) || !finiteIn(lon, 180))
      throw new Error('invalid_map');
    return { lat, lon };
  };
  const center = point('center_latitude', 'center_longitude');
  const corners = {
    sw: point('lat0', 'lon0'),
    nw: point('lat1', 'lon1'),
    ne: point('lat2', 'lon2'),
    se: point('lat3', 'lon3'),
  };
  const lats = Object.values(corners).map(({ lat }) => lat);
  const lons = Object.values(corners).map(({ lon }) => lon);
  const bounds = {
    west: Math.min(...lons),
    south: Math.min(...lats),
    east: Math.max(...lons),
    north: Math.max(...lats),
  };
  // A degenerate or inverted box cannot be draped; a radar image spans degrees.
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  if (!(width > 0.05) || !(height > 0.05) || width > 30 || height > 30)
    throw new Error('invalid_map');
  // "64 Adelaide (128 km)": id, name, range.
  const heading = header
    ? /^\d+\s+(.+?)\s*(?:\((\d+)\s*km\))?$/.exec(header)
    : null;
  const name = heading?.[1]?.trim() || null;
  return {
    name: name && name.length <= 80 ? name : null,
    rangeKm: heading?.[2] ? Number(heading[2]) : null,
    projection: values.get('projection') ?? null,
    center,
    corners,
    bounds,
  };
}

/** Rows at the top of every BoM radar image taken by an opaque title bar. */
export const BOM_HEADER_ROWS = 16;

/**
 * Hide the furniture BoM bakes into each radar PNG: a title bar across the
 * first 16 rows, and the caption text (pure opaque black) and header grey
 * (193, 193, 193) anywhere else. The rain palette never contains either colour.
 * Display-only cleanup of an RGBA buffer, in place: matching pixels become fully
 * transparent and every other byte is left exactly as it was.
 * @param {Uint8ClampedArray|Uint8Array} rgba Row-major RGBA pixels.
 * @param {number} width
 * @param {number} height
 * @returns {Uint8ClampedArray|Uint8Array} The same buffer.
 */
export function maskBomFurniture(rgba, width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    !rgba ||
    rgba.length !== width * height * 4
  )
    throw new TypeError('Invalid radar pixel buffer');
  const header = Math.min(height, BOM_HEADER_ROWS) * width * 4;
  rgba.fill(0, 0, header);
  for (let i = header; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) continue;
    const r = rgba[i];
    if (
      (r === 0 && rgba[i + 1] === 0 && rgba[i + 2] === 0) ||
      (r === 193 && rgba[i + 1] === 193 && rgba[i + 2] === 193)
    )
      rgba.fill(0, i, i + 4);
  }
  return rgba;
}
