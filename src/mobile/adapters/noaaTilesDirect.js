import {
  UPSTREAM_NOT_ALLOWED,
  createPacer,
  isUpstreamRefusal,
} from '../sourcePolicy.js';

/**
 * On-device NOAA tiles: direct NOAA nowCOAST WMS manifest/tile/image access.
 *
 * Self-contained port of the validation logic in
 * `server/providers/weather.js` (canonical pointers are kept on each helper):
 * - Capabilities parsing with XML hardening (size limits, DOCTYPE rejection)
 * - Tile bounds validation (levels 0-6, geographic tiling scheme)
 * - Time canonicalization (explicit UTC only, no future times)
 * - BBox validation (2:1 aspect, 0.25° rounding, containment in product bounds)
 * - Image size allowlist (1024x512, 2048x1024, 4096x2048 per product max)
 * - PNG header/dimension validation (Web-API-only: DataView, no Buffer)
 *
 * The server proxy handles caching and coalescing; on-device we validate
 * and fetch directly from NOAA WMS endpoints.
 *
 * @module mobile/adapters/noaaTilesDirect
 */

const BASE = 'https://nowcoast.noaa.gov/geoserver/observations/';
const HOUR = 3600_000;

/**
 * NOAA nowCOAST products. Canonical implementation: server/providers/weather.js.
 * @type {Record<string, {service: string, layer: string, style: string, title: string, coverage: string, description: string, attribution?: string, metadataTtlMs?: number, image: {width: number, height: number}}>}
 */
export const PRODUCTS = Object.freeze({
  lightning: Object.freeze({
    service: 'lightning_detection',
    layer: 'ldn_lightning_strike_density',
    style: 'lightning_density',
    title: 'Lightning density · 15 min',
    coverage:
      'Pacific and Americas: 110°E across the dateline to 0°, 25°S–80°N; not global coverage.',
    description:
      'Observed 15-minute lightning strike density on an approximately 8 km grid, scaled as strikes/km²/min ×10³. Ground-network density, not individual GLM flashes.',
    attribution: 'NOAA/NWS nowCOAST; derived from Vaisala NLDN/GLD360',
    metadataTtlMs: 600_000,
    image: Object.freeze({ width: 4096, height: 2048 }),
  }),
  radar: Object.freeze({
    service: 'weather_radar',
    layer: 'conus_base_reflectivity_mosaic',
    style: 'weather_radar_base_reflectivity',
    title: 'CONUS radar reflectivity',
    coverage:
      'Contiguous United States; gaps do not establish absence of precipitation.',
    description:
      'Observed MRMS radar base reflectivity (dBZ), approximately 1 km and 4-minute updates; not a rainfall forecast.',
    image: Object.freeze({ width: 4096, height: 2048 }),
  }),
  clouds: Object.freeze({
    service: 'satellite',
    layer: 'global_longwave_imagery_mosaic',
    style: 'reflectance',
    title: 'Global satellite infrared',
    coverage:
      'Global mosaic with incomplete polar coverage; nominal coverage 60°S–60°N.',
    description:
      'Longwave infrared cloud and land/sea temperature patterns, approximately 3 km; hourly updates with 2–3 hour source latency. Not a cloud-only mask.',
    image: Object.freeze({ width: 2048, height: 1024 }),
  }),
  'clouds-regional': Object.freeze({
    service: 'satellite',
    layer: 'goes_longwave_imagery',
    style: 'goes-lir',
    title: 'GOES regional satellite infrared',
    coverage:
      'GOES East/West regional North American coverage; not a global image.',
    description:
      'GOES-19/18 longwave infrared Band 14 cloud and surface temperature patterns, approximately 2 km and 5-minute updates. Not a cloud-only mask.',
    image: Object.freeze({ width: 4096, height: 2048 }),
  }),
});

// Whole-extent images: 2:1 sizes up to each product's largest (the default).
const IMAGE_SIZES = Object.freeze(['1024x512', '2048x1024', '4096x2048']);
// Detail windows: any product up to 4096×2048 (the default).
const DETAIL_IMAGE = Object.freeze({ width: 4096, height: 2048 });
const TILE_SIZES = Object.freeze(['256', '512', '1024']);
const BBOX_STEP = 0.25;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_CAPABILITIES_BYTES = 512 * 1024;
const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 12_000;

const metadataCache = new Map();
const tileCache = new Map();
let tileBytes = 0;

/**
 * Create the on-device NOAA tiles direct source.
 * @param {{ fetchImpl?: Function, pacer?: { wait: Function }, timeoutMs?: number }} options
 * @returns {{ getManifest: Function, getTile: Function, getImage: Function }}
 */
export function createNoaaTilesDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  pacer = createPacer(DEFAULT_MIN_INTERVAL_MS),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const inFlight = new Map();
  const metadataAttempts = new Map();

  /**
   * Get product manifest (metadata + available times).
   * @param {string} product One of: 'radar', 'clouds', 'clouds-regional', 'lightning'
   * @param {{ signal?: AbortSignal }} options
   * @returns {Promise<object>} Manifest: { schemaVersion, product, title, coverage, description, source, attribution, bounds, times, allowedTimes, latest, observedAt, fetchedAt, stale, unavailable?, reason?, tileSize, maxLevel, tilingScheme, tileTemplate, imageUrl, imageSize }
   */
  async function getManifest(product, { signal } = {}) {
    if (!PRODUCTS[product]) throw new Error('Unknown weather product');

    const key = `manifest:${product}`;
    let inflight = inFlight.get(key);
    if (!inflight) {
      inflight = (async () => {
        const nowMs = Date.now();
        try {
          await pacer.wait({ signal });
          signal?.throwIfAborted();

          const spec = PRODUCTS[product];
          const cached = metadataCache.get(product);

          // Return cached if fresh
          const ttl = spec.metadataTtlMs ?? 120_000;
          if (cached && nowMs - cached.fetchedAt < ttl) {
            return describe(product, cached, false);
          }

          // Rate limit metadata requests
          if (nowMs - (metadataAttempts.get(product) ?? -Infinity) < 30_000) {
            if (cached) return describe(product, cached, true);
            throw new Error('Weather metadata temporarily unavailable');
          }
          metadataAttempts.set(product, nowMs);

          const url = `${BASE}${spec.service}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
          const response = await fetchWithTimeout(fetchImpl, url, {
            signal,
            redirect: 'error',
            headers: { Accept: 'application/xml,text/xml' },
            timeoutMs,
          });

          if (!response.ok) {
            await response.body?.cancel();
            if (cached && nowMs - cached.fetchedAt <= HOUR) {
              return describe(product, cached, true);
            }
            throw new Error('Weather metadata unavailable');
          }

          const xml = await readResponseTextCapped(
            response,
            MAX_CAPABILITIES_BYTES,
            signal,
          );
          signal?.throwIfAborted();

          const value = {
            ...parseWeatherCapabilities(xml, product, nowMs),
            fetchedAt: nowMs,
          };
          metadataCache.set(product, value);
          metadataAttempts.delete(product);

          return describe(product, value, false);
        } catch (error) {
          if (isUpstreamRefusal(error)) {
            return { unavailable: UPSTREAM_NOT_ALLOWED };
          }
          // Return stale cached data if available
          const cached = metadataCache.get(product);
          if (cached && nowMs - cached.fetchedAt <= HOUR) {
            return describe(product, cached, true);
          }
          return describe(product, null, true);
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, inflight);
    }

    return inflight;
  }

  /**
   * Get a WMS tile.
   * @param {string} product Product id
   * @param {string} time ISO8601 timestamp (must be in manifest's allowedTimes)
   * @param {number} z Zoom level (0-6)
   * @param {number} x Tile X
   * @param {number} y Tile Y
   * @param {{ size?: string, signal?: AbortSignal }} options
   * @returns {Promise<Uint8Array>} PNG image bytes
   */
  async function getTile(
    product,
    time,
    z,
    x,
    y,
    { size = '256', signal } = {},
  ) {
    validateTileParams(product, time, z, x, y, size);
    return fetchTileOrImage(product, time, { z, x, y }, size, false, signal);
  }

  /**
   * Get a full-image or detail-window image.
   * @param {string} product Product id
   * @param {string} time ISO8601 timestamp
   * @param {{ size?: string, bbox?: string, signal?: AbortSignal }} options
   * @returns {Promise<Uint8Array>} PNG image bytes
   */
  async function getImage(product, time, { size, bbox, signal } = {}) {
    const detailBox = bbox ? weatherImageBbox(bbox) : null;
    validateImageParams(product, time, size, detailBox);
    const spec = PRODUCTS[product];
    const largest = detailBox ? DETAIL_IMAGE : spec.image;
    const resolvedSize = size ?? `${largest.width}x${largest.height}`;
    return fetchTileOrImage(
      product,
      time,
      detailBox,
      resolvedSize,
      true,
      signal,
    );
  }

  /**
   * Validate tile parameters.
   */
  function validateTileParams(product, time, z, x, y, size) {
    if (!PRODUCTS[product]) throw new Error('Unknown weather product');
    if (!time || observationTime(time) !== time)
      throw new Error('Invalid weather time');
    if (!TILE_SIZES.includes(size))
      throw new Error('Invalid weather tile size');
    if (!Number.isInteger(z) || z < 0 || z > 6)
      throw new Error('Invalid zoom level');
    if (!Number.isInteger(x) || x < 0 || x >= 2 ** (z + 1))
      throw new Error('Invalid tile x');
    if (!Number.isInteger(y) || y < 0 || y >= 2 ** z)
      throw new Error('Invalid tile y');
  }

  /**
   * Validate image parameters.
   */
  function validateImageParams(product, time, size, detailBox) {
    if (!PRODUCTS[product]) throw new Error('Unknown weather product');
    if (!time || observationTime(time) !== time)
      throw new Error('Invalid weather time');
    const spec = PRODUCTS[product];
    const largest = detailBox ? DETAIL_IMAGE : spec.image;
    const requestedSize = size ?? `${largest.width}x${largest.height}`;
    if (!IMAGE_SIZES.includes(requestedSize))
      throw new Error('Invalid weather image size');
    const [w] = requestedSize.split('x').map(Number);
    if (w > largest.width) throw new Error('Invalid weather image size');
  }

  /**
   * Fetch tile or image from NOAA WMS.
   * @param {string} product
   * @param {string} time
   * @param {{z:number,x:number,y:number}|Array<number>|null} coordsOrBbox Tile coords, detail bbox, or null (whole image).
   * @param {string} size Tile edge ('256') or image WxH.
   * @param {boolean} wholeImage
   * @param {AbortSignal} [signal]
   */
  async function fetchTileOrImage(
    product,
    time,
    coordsOrBbox,
    size,
    wholeImage,
    signal,
  ) {
    await pacer.wait({ signal });
    signal?.throwIfAborted();

    // Get metadata first (validates time, gets bounds)
    const manifest = await getManifest(product, { signal });
    if (manifest.unavailable) throw new Error('Weather metadata unavailable');

    // Validate time is allowed
    if (
      !manifest.allowedTimes?.includes(time) ||
      Date.now() - Date.parse(time) > 24 * HOUR
    ) {
      throw new Error('Unknown weather time');
    }

    // Resolve the request bbox: detail window, tile bounds, or whole extent.
    let bbox;
    if (Array.isArray(coordsOrBbox)) {
      bbox = coordsOrBbox;
      if (
        bbox[0] < manifest.bounds.west ||
        bbox[1] < manifest.bounds.south ||
        bbox[2] > manifest.bounds.east ||
        bbox[3] > manifest.bounds.north
      ) {
        throw new Error('Invalid weather bbox');
      }
    } else if (coordsOrBbox && !wholeImage) {
      const { z, x, y } = coordsOrBbox;
      bbox = weatherTileBounds(z, x, y);
    } else {
      bbox = [
        manifest.bounds.west,
        manifest.bounds.south,
        manifest.bounds.east,
        manifest.bounds.north,
      ];
    }

    // Tiles are square (edge px); images are WxH.
    const [width, height] = wholeImage
      ? size.split('x').map(Number)
      : [Number(size), Number(size)];
    const imageShape = {
      width,
      height,
      maxBytes: wholeImage
        ? MAX_IMAGE_BYTES
        : Math.max(1024 * 1024, width ** 2 * 4 + 65_536),
    };

    // Cache key
    const key = wholeImage
      ? `${product}:${time}:image:${size}:${bbox.join(',')}`
      : `${product}:${time}:tile:${size}:${coordsOrBbox.z}/${coordsOrBbox.x}/${coordsOrBbox.y}`;

    // Check cache
    const cached = tileCache.get(key);
    if (cached && Date.now() - cached.at <= 24 * HOUR) {
      tileCache.delete(key);
      tileCache.set(key, cached);
      return cached.bytes;
    }

    // Don't use stale metadata
    if (manifest.stale) throw new Error('Weather metadata stale');

    const spec = PRODUCTS[product];
    const upstreamUrl = new URL(`${BASE}${spec.service}/ows`);
    upstreamUrl.search = new URLSearchParams({
      service: 'WMS',
      version: '1.1.1',
      request: 'GetMap',
      layers: spec.layer,
      styles: spec.style,
      srs: 'EPSG:4326',
      bbox: bbox.join(','),
      width: String(width),
      height: String(height),
      format: 'image/png',
      transparent: 'true',
      time,
    }).toString();

    const response = await fetchWithTimeout(fetchImpl, upstreamUrl.href, {
      signal,
      redirect: 'error',
      headers: { Accept: 'image/png' },
      timeoutMs,
    });

    if (
      !response.ok ||
      !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '')
    ) {
      await response.body?.cancel();
      throw new Error('Weather upstream unavailable');
    }

    const bytes = await readResponseBytesCapped(
      response,
      imageShape.maxBytes,
      signal,
    );
    signal?.throwIfAborted();

    // Validate PNG header
    validatePng(bytes, width, height);

    // Cache
    rememberTile(key, bytes);

    return bytes;
  }

  return { getManifest, getTile, getImage };
}

/**
 * Fetch with a client-side abort deadline (fetchImpl may be CapacitorHttp,
 * which cannot cancel in flight — the deadline still bounds the wait).
 */
async function fetchWithTimeout(
  fetchImpl,
  url,
  { timeoutMs, signal, ...init },
) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    signal?.throwIfAborted();
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Describe product for manifest response.
 */
function describe(product, value, stale) {
  const spec = PRODUCTS[product];
  const time = value?.times?.at(-1) ?? null;
  return {
    schemaVersion: 1,
    product,
    title: spec.title,
    coverage: spec.coverage,
    description: spec.description,
    source: 'NOAA nowCOAST',
    attribution: spec.attribution ?? 'NOAA/NWS/NESDIS nowCOAST',
    bounds: value?.bounds ?? null,
    times: value?.times ?? [],
    allowedTimes: value?.allowedTimes ?? [],
    latest: time,
    time,
    observedAt: time,
    fetchedAt: value?.fetchedAt ?? null,
    stale: value ? stale : true,
    unavailable: !value,
    reason: !value
      ? 'Weather imagery unavailable'
      : value.stale
        ? 'Cached weather metadata; upstream unavailable'
        : null,
    tileSize: 256,
    maxLevel: 6,
    tilingScheme: 'geographic',
    tileTemplate: time
      ? `/api/weather/tile?product=${product}&time=${encodeURIComponent(time)}&z={z}&x={x}&y={y}`
      : null,
    imageUrl: time
      ? `/api/weather/image?product=${product}&time=${encodeURIComponent(time)}`
      : null,
    imageSize: { ...spec.image },
  };
}

/**
 * Validate PNG header and dimensions (Web-API-only: DataView, no Buffer).
 * @param {Uint8Array} bytes
 * @param {number} width
 * @param {number} height
 */
function validatePng(bytes, width, height) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const ascii = (start, end) => {
    let s = '';
    for (let i = start; i < end; i++)
      s += String.fromCharCode(view.getUint8(i));
    return s;
  };
  if (
    buffer.length < 33 ||
    view.getUint8(0) !== 137 ||
    view.getUint8(1) !== 80 ||
    view.getUint8(2) !== 78 ||
    view.getUint8(3) !== 71 ||
    view.getUint8(4) !== 13 ||
    view.getUint8(5) !== 10 ||
    view.getUint8(6) !== 26 ||
    view.getUint8(7) !== 10 ||
    view.getUint32(8) !== 13 ||
    ascii(12, 16) !== 'IHDR' ||
    view.getUint32(16) !== width ||
    view.getUint32(20) !== height
  ) {
    throw new Error('Invalid weather image');
  }
}

/**
 * Remember tile in LRU cache.
 */
function rememberTile(key, bytes) {
  if (tileCache.has(key)) tileBytes -= tileCache.get(key).bytes.length;
  tileCache.delete(key);
  while (tileCache.size >= 128 || tileBytes + bytes.length > 16 * 1024 * 1024) {
    const oldest = tileCache.keys().next().value;
    tileBytes -= tileCache.get(oldest).bytes.length;
    tileCache.delete(oldest);
  }
  tileCache.set(key, { bytes, at: Date.now() });
  tileBytes += bytes.length;
}

/**
 * Read response text with cap.
 */
async function readResponseTextCapped(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(result);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read response bytes with cap.
 */
async function readResponseBytesCapped(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  if (!response.body) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Ported from server/providers/weather.js (pure validation, Node-free).
// Canonical pointer: server/providers/weather.js
// ---------------------------------------------------------------------------

/**
 * Coded failure matching the server's weather error contract.
 */
function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

/**
 * Canonicalize only explicit UTC observations; never expand time intervals.
 * @param {string} value
 * @returns {string|null} Canonical ISO time, or null when not explicit UTC.
 */
export function observationTime(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const canonical = date.toISOString();
  return canonical.replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
    ? canonical
    : null;
}

/**
 * Read the named leaf from bounded capabilities without resolving XML entities.
 * @param {string} xml Raw GetCapabilities XML.
 * @param {string} product Product id.
 * @param {number} [nowMs] Injectable clock.
 * @returns {{ bounds: object, times: Array<string>, allowedTimes: Array<string> }}
 */
export function parseWeatherCapabilities(xml, product, nowMs = Date.now()) {
  const spec = PRODUCTS[product];
  if (
    !spec ||
    typeof xml !== 'string' ||
    xml.length > MAX_CAPABILITIES_BYTES ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw failure('invalid_weather_metadata');
  const stack = [];
  let leaf = null;
  let tags = 0;
  for (const match of xml.matchAll(/<\/?(?:[\w.-]+:)?Layer\b[^>]*>/g)) {
    if (++tags > 2048) throw failure('invalid_weather_metadata');
    if (!match[0].startsWith('</')) {
      if (stack.length) stack.at(-1).nested = true;
      if (stack.length >= 16 || match[0].endsWith('/>'))
        throw failure('invalid_weather_metadata');
      stack.push({ start: match.index + match[0].length, nested: false });
    } else {
      const opened = stack.pop();
      if (!opened) throw failure('invalid_weather_metadata');
      if (opened.nested) continue;
      const candidate = xml.slice(opened.start, match.index);
      const name = candidate
        .match(/<(?:[\w.-]+:)?Name\s*>([^<]+)<\/(?:[\w.-]+:)?Name>/)?.[1]
        ?.trim();
      if (name === spec.layer) {
        if (leaf !== null) throw failure('invalid_weather_metadata');
        leaf = candidate;
      }
    }
  }
  if (stack.length || !leaf) throw failure('invalid_weather_metadata');
  const box = leaf.match(
    /<(?:[\w.-]+:)?EX_GeographicBoundingBox\s*>([\s\S]*?)<\/(?:[\w.-]+:)?EX_GeographicBoundingBox>/,
  )?.[1];
  const bounds = {};
  for (const [key, tag] of Object.entries({
    west: 'westBoundLongitude',
    south: 'southBoundLatitude',
    east: 'eastBoundLongitude',
    north: 'northBoundLatitude',
  })) {
    const value = box
      ?.match(
        new RegExp(`<(?:[\\w.-]+:)?${tag}\\s*>([^<]+)</(?:[\\w.-]+:)?${tag}>`),
      )?.[1]
      ?.trim();
    bounds[key] = value ? Number(value) : NaN;
  }
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north
  )
    throw failure('invalid_weather_metadata');
  const dimensions = [
    ...leaf.matchAll(
      /<(?:[\w.-]+:)?Dimension\b([^>]*)>([^<]*)<\/(?:[\w.-]+:)?Dimension>/g,
    ),
  ].filter((entry) => /\bname\s*=\s*["']time["']/.test(entry[1]));
  if (
    dimensions.length !== 1 ||
    !/\bunits\s*=\s*["']ISO8601["']/.test(dimensions[0][1])
  )
    throw failure('invalid_weather_metadata');
  const raw = dimensions[0][2].trim().split(',');
  if (!raw.length || raw.length > 512)
    throw failure('invalid_weather_metadata');
  const times = raw.map((value) => observationTime(value.trim()));
  if (times.some((value) => !value || Date.parse(value) > nowMs + 5 * 60_000))
    throw failure('invalid_weather_metadata');
  const defaultTime = observationTime(
    dimensions[0][1].match(/\bdefault\s*=\s*["']([^"']+)["']/)?.[1],
  );
  if (!defaultTime || !times.includes(defaultTime))
    throw failure('invalid_weather_metadata');
  const recent = [...new Set(times)]
    .filter((value) => nowMs - Date.parse(value) <= 24 * HOUR)
    .sort()
    .slice(-26);
  if (!recent.length) throw failure('weather_observations_expired');
  return { bounds, times: recent.slice(-13), allowedTimes: recent };
}

/**
 * A detail window `west,south,east,north` in degrees, rounded to 0.25° so cache
 * keys repeat, with a 2:1 aspect within 1 %; null when absent. Containment in
 * the product bounds is checked once the metadata is known.
 * @param {string|null} value
 * @returns {Array<number>|null}
 */
export function weatherImageBbox(value) {
  if (value === null) return null;
  const parts = value.split(',');
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^-?\d{1,3}(?:\.\d{1,6})?$/.test(part))
  )
    throw failure('invalid_weather_bbox', 400);
  // `+ 0` turns a rounded -0 into 0 so equal windows share one key.
  const [west, south, east, north] = parts.map(
    (part) => Math.round(Number(part) / BBOX_STEP) * BBOX_STEP + 0,
  );
  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north ||
    Math.abs((east - west) / (north - south) / 2 - 1) > 0.01
  )
    throw failure('invalid_weather_bbox', 400);
  return [west, south, east, north];
}

/**
 * GeographicTilingScheme's two longitude tiles and one latitude tile at level zero.
 * @param {number} z Zoom level (0-6).
 * @param {number} x Tile X.
 * @param {number} y Tile Y.
 * @returns {Array<number>} [west, south, east, north].
 */
export function weatherTileBounds(z, x, y) {
  if (
    ![z, x, y].every(Number.isInteger) ||
    z < 0 ||
    z > 6 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** (z + 1) ||
    y >= 2 ** z
  )
    throw failure('invalid_weather_tile', 400);
  const span = 180 / 2 ** z;
  return [
    -180 + x * span,
    90 - (y + 1) * span,
    -180 + (x + 1) * span,
    90 - y * span,
  ];
}
