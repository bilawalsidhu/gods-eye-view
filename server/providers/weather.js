import { readResponseTextCapped } from './common/http.js';
import { readWindBody as readBytesCapped } from '../../src/sources/windBody.js';

const BASE = 'https://nowcoast.noaa.gov/geoserver/observations/';
const HOUR = 3600_000;
const PRODUCTS = Object.freeze({
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
const BBOX_STEP = 0.25;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

/** Canonicalize only explicit UTC observations; never expand time intervals. */
function observationTime(value) {
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

/** Read the named leaf from bounded capabilities without resolving XML entities. */
export function parseWeatherCapabilities(xml, product, nowMs = Date.now()) {
  const spec = PRODUCTS[product];
  if (
    !spec ||
    typeof xml !== 'string' ||
    xml.length > 512 * 1024 ||
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

/** A detail window `west,south,east,north` in degrees, rounded to 0.25° so cache
 * keys repeat, with a 2:1 aspect within 1 %; null when absent. Containment in
 * the product bounds is checked once the metadata is known. */
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

/** GeographicTilingScheme's two longitude tiles and one latitude tile at level zero. */
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

function validatePng(bytes, width, height) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.length < 33 ||
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString('ascii', 12, 16) !== 'IHDR' ||
    buffer.readUInt32BE(16) !== width ||
    buffer.readUInt32BE(20) !== height
  )
    throw failure('invalid_weather_image');
  return buffer;
}

/** Fixed NOAA observed-weather metadata and WMS tiles; no client-supplied destinations. */
export function weatherProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 12_000,
} = {}) {
  const metadata = new Map();
  const attempts = new Map();
  const operations = new Map();
  const pending = [];
  const tiles = new Map();
  const tileFailures = new Map();
  let tileBytes = 0;
  let active = 0;

  function pump() {
    while (active < 8 && pending.length) {
      const operation = pending.shift();
      if (operation.controller.signal.aborted) continue;
      active++;
      operation.started = true;
      Promise.resolve()
        .then(() => operation.work(operation.controller.signal))
        .then(operation.resolve, operation.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }
  async function shared(key, work, clientSignal) {
    clientSignal.throwIfAborted();
    let operation = operations.get(key);
    if (operation?.controller.signal.aborted) {
      operations.delete(key);
      operation = null;
    }
    if (!operation) {
      if (operations.size >= 120 || pending.length >= 96)
        throw failure('weather_busy', 429);
      const controller = new AbortController();
      operation = { controller, work, waiters: 0, started: false };
      operation.promise = new Promise((resolve, reject) => {
        operation.resolve = resolve;
        operation.reject = reject;
      });
      const cancel = () => {
        const index = pending.indexOf(operation);
        if (index >= 0) pending.splice(index, 1);
        operation.reject(failure('weather_request_cancelled'));
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      operation.promise = operation.promise.finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', cancel);
        if (operations.get(key) === operation) operations.delete(key);
      });
      operations.set(key, operation);
      pending.push(operation);
      pump();
    }
    operation.waiters++;
    const abort = () => {
      if (--operation.waiters === 0) operation.controller.abort();
    };
    clientSignal.addEventListener('abort', abort, { once: true });
    try {
      const value = await operation.promise;
      clientSignal.throwIfAborted();
      return value;
    } finally {
      clientSignal.removeEventListener('abort', abort);
      if (!clientSignal.aborted) operation.waiters--;
    }
  }
  async function upstream(url, signal, image = null) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: image ? 'image/png' : 'application/xml,text/xml' },
    });
    if (
      !response.ok ||
      (image &&
        !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || ''))
    ) {
      await response.body?.cancel();
      throw failure('weather_upstream_unavailable');
    }
    const value = image
      ? validatePng(
          await readBytesCapped(response, image.maxBytes, signal),
          image.width,
          image.height,
        )
      : await readResponseTextCapped(response, 512 * 1024, signal);
    signal.throwIfAborted();
    return value;
  }
  async function getMetadata(product, signal) {
    signal.throwIfAborted();
    const old = metadata.get(product);
    const spec = PRODUCTS[product];
    if (old && now() - old.fetchedAt < (spec.metadataTtlMs ?? 120_000))
      return { ...old, stale: false };
    try {
      if (
        now() - (attempts.get(product) ?? -Infinity) < 30_000 &&
        !operations.has(`metadata:${spec.service}`)
      )
        throw failure('weather_upstream_unavailable');
      attempts.set(product, now());
      const url = `${BASE}${spec.service}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
      const xml = await shared(
        `metadata:${spec.service}`,
        (activeSignal) => upstream(url, activeSignal),
        signal,
      );
      const value = {
        ...parseWeatherCapabilities(xml, product, now()),
        fetchedAt: now(),
      };
      metadata.set(product, value);
      return { ...value, stale: false };
    } catch (error) {
      if (signal.aborted) attempts.delete(product);
      signal.throwIfAborted();
      if (error.status === 429) throw error;
      if (old && now() - old.fetchedAt <= HOUR) return { ...old, stale: true };
      throw failure('weather_metadata_unavailable');
    }
  }
  function rememberTile(key, bytes) {
    if (tiles.has(key)) tileBytes -= tiles.get(key).bytes.length;
    tiles.delete(key);
    while (tiles.size >= 128 || tileBytes + bytes.length > 16 * 1024 * 1024) {
      const oldest = tiles.keys().next().value;
      tileBytes -= tiles.get(oldest).bytes.length;
      tiles.delete(oldest);
    }
    tiles.set(key, { bytes, at: now() });
    tileBytes += bytes.length;
  }
  function describe(product, value) {
    const spec = PRODUCTS[product];
    const time = value?.times.at(-1) ?? null;
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
      latest: time,
      time,
      observedAt: time,
      fetchedAt: value?.fetchedAt ?? null,
      stale: value?.stale ?? true,
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
  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 429 ? { 'Retry-After': '2' } : {}),
    });
    res.end(JSON.stringify(body));
  }
  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET')
        return json(res, 405, { error: 'method_not_allowed' });
      if (!['/manifest', '/tile', '/image'].includes(url.pathname))
        return json(res, 404, { error: 'not_found' });
      const allowed =
        url.pathname === '/manifest'
          ? ['product']
          : url.pathname === '/image'
            ? ['product', 'time', 'size', 'bbox']
            : ['product', 'time', 'z', 'x', 'y', 'size'];
      if (
        req.url.length > 512 ||
        [...url.searchParams.keys()].some(
          (key) =>
            !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
        )
      )
        return json(res, 400, { error: 'invalid_weather_query' });
      const product = url.searchParams.get('product');
      if (!Object.hasOwn(PRODUCTS, product))
        return json(res, 400, { error: 'unknown_weather_product' });
      const wholeImage = url.pathname === '/image';
      const detailBox = wholeImage
        ? weatherImageBbox(url.searchParams.get('bbox'))
        : null;
      const largest = detailBox ? DETAIL_IMAGE : PRODUCTS[product].image;
      const size =
        url.searchParams.get('size') ??
        (wholeImage ? `${largest.width}x${largest.height}` : '256');
      if (
        wholeImage
          ? !IMAGE_SIZES.includes(size) ||
            Number.parseInt(size, 10) > largest.width
          : !['256', '512', '1024'].includes(size)
      )
        throw failure(
          wholeImage
            ? 'invalid_weather_image_size'
            : 'invalid_weather_tile_size',
          400,
        );
      if (url.pathname === '/manifest') {
        try {
          const value = await getMetadata(product, controller.signal);
          controller.signal.throwIfAborted();
          return json(res, 200, describe(product, value));
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error.status === 429) throw error;
          return json(res, 200, describe(product, null));
        }
      }
      const coords = wholeImage
        ? null
        : ['z', 'x', 'y'].map((key) => url.searchParams.get(key));
      if (coords?.some((value) => !/^(?:0|[1-9]\d{0,2})$/.test(value ?? '')))
        throw failure('invalid_weather_tile', 400);
      const tileBounds = coords
        ? weatherTileBounds(...coords.map(Number))
        : null;
      const time = url.searchParams.get('time');
      if (!time || observationTime(time) !== time)
        throw failure('invalid_weather_time', 400);
      const value = await getMetadata(product, controller.signal);
      controller.signal.throwIfAborted();
      if (
        !value.allowedTimes.includes(time) ||
        now() - Date.parse(time) > 24 * HOUR
      )
        throw failure('unknown_weather_time', 400);
      if (
        detailBox &&
        (detailBox[0] < value.bounds.west ||
          detailBox[1] < value.bounds.south ||
          detailBox[2] > value.bounds.east ||
          detailBox[3] > value.bounds.north)
      )
        throw failure('invalid_weather_bbox', 400);
      // A single advertised extent keeps NOAA's global reflectance contrast
      // consistent across the image; independently normalized tiles create seams.
      const bbox =
        detailBox ??
        (wholeImage
          ? [
              value.bounds.west,
              value.bounds.south,
              value.bounds.east,
              value.bounds.north,
            ]
          : tileBounds);
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
      // NOAA WMS capabilities advertise no MaxWidth/MaxHeight. One GetMap
      // returns a whole 4096×2048 extent or window, or a 1024 px tile, without
      // composition. Images are keyed by product, time, size and bbox.
      const key = `${product}:${time}:${wholeImage ? `image:${size}:${bbox.join(',')}` : `tile:${size}:${coords.join('/')}`}`;
      let cached = tiles.get(key);
      if (cached && now() - cached.at <= 24 * HOUR) {
        tiles.delete(key);
        tiles.set(key, cached);
      } else {
        // Never ask nearestValue=1 WMS to silently replace an expired frame.
        if (value.stale) throw failure('weather_metadata_stale');
        if (now() - (tileFailures.get(key) ?? -Infinity) < 30_000)
          throw failure('weather_upstream_unavailable');
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
          width: String(imageShape.width),
          height: String(imageShape.height),
          format: 'image/png',
          transparent: 'true',
          time,
        }).toString();
        try {
          const bytes = await shared(
            `image:${key}`,
            (signal) => upstream(upstreamUrl.href, signal, imageShape),
            controller.signal,
          );
          rememberTile(key, bytes);
          cached = { bytes };
        } catch (error) {
          if (!controller.signal.aborted && error.status !== 429) {
            tileFailures.delete(key);
            tileFailures.set(key, now());
            while (tileFailures.size > 128)
              tileFailures.delete(tileFailures.keys().next().value);
          }
          throw error;
        }
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(cached.bytes);
    } catch (error) {
      if (!controller.signal.aborted)
        json(
          res,
          error.status === 400 || error.status === 429 ? error.status : 503,
          {
            error:
              error.status === 400 || error.status === 429
                ? error.code
                : 'weather_upstream_unavailable',
          },
        );
    } finally {
      res.removeListener?.('close', close);
    }
  }
  return {
    name: 'weather',
    configureServer({ middlewares }) {
      middlewares.use('/api/weather', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/weather', handler);
    },
  };
}
