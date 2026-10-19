import {
  BOM_LOOP_FRAMES,
  groupBomProductsByRadar,
  isBomFrameFile,
  isBomProduct,
  newestBomFrames,
  parseBomFrameName,
  parseBomRadarListing,
  parseBomRadarMap,
} from '../../src/layers/bomRadar/records.js';
import { coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { createBomFtp } from './bomRadar/ftp.js';
import { createFrameCache } from './bomRadar/frameCache.js';

// Bureau of Meteorology anonymous-FTP radar products.
//
// LICENCE: BoM anonymous-FTP products may be used for personal use or within an
// organisation, but not supplied to any other person or used commercially
// (https://www.bom.gov.au/catalogue/anon-ftp.shtml). This proxy is therefore
// OFF unless the operator sets BOM_RADAR_ENABLED=1, fetches frames live for
// that operator's own browser, keeps them only in a bounded in-memory cache
// and never writes imagery to disk.
const RADAR_DIR = '/anon/gen/radar/';
const MAP_DIR = '/anon/gen/radar_transparencies/coordinates/';

const LISTING_TTL_MS = 300_000;
// Radar imagery older than this is no longer a nowcast; stop serving a stale
// listing (BoM has long since deleted those frames upstream).
const MAX_STALE_MS = 3 * 3_600_000;
const LISTING_RETRY_MS = 30_000;
const MAP_TTL_MS = 24 * 3_600_000;
const MAP_RETRY_MS = 600_000;
const MAX_MAP_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
// /products fetches one .map per radar (about 70 in the national listing)
// over the single shared FTP connection. This caps one warm-up pass, and each
// radar is fetched at most once per MAP_TTL_MS (MAP_RETRY_MS after a failure).
const MAX_WARM_RADARS = 150;
const WARM_ABORT_AFTER_FAILURES = 3;
// /products answers after this long with whatever radars have been located so
// far (`complete: false`); the warm-up carries on and the client asks again.
const WARM_WAIT_MS = 4000;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const truthy = (value) =>
  ['1', 'true'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );

/**
 * Whether the operator has opted in. Read at request time, not import time:
 * modules load before Vite copies .env into process.env.
 * @param {Record<string, string|undefined>} [env]
 */
export function bomRadarEnabled(env = process.env) {
  return truthy(env.BOM_RADAR_ENABLED);
}

/** True for bytes that begin with the PNG signature. */
export function isPng(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length > PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

/**
 * Opt-in, fixed-origin BoM radar routes for dev and preview.
 * @param {object} [options]
 * @param {ReturnType<typeof createBomFtp>} [options.ftp] Injected in tests so
 *   nothing touches the network; otherwise built on first use.
 * @param {() => Record<string, string|undefined>} [options.env]
 * @param {() => number} [options.now]
 * @param {number} [options.warmWaitMs]
 * @param {{maxFrames?: number, maxBytes?: number}} [options.cache]
 */
export function bomRadarProxy({
  ftp: injectedFtp,
  env = () => process.env,
  now = () => Date.now(),
  warmWaitMs = WARM_WAIT_MS,
  cache: cacheLimits,
} = {}) {
  let ftp = injectedFtp ?? null;
  // Set when the dev or preview server closes: nothing may reach BoM after it.
  let closed = false;
  const closedError = () => new Error('bom_radar_closed');
  const getFtp = () => {
    if (closed) throw closedError();
    return (ftp ??= createBomFtp());
  };
  /** Stop all background work and refuse further upstream requests. */
  function dispose() {
    if (closed) return;
    closed = true;
    if (typeof ftp?.shutdown === 'function') ftp.shutdown();
    else ftp?.close?.();
  }
  const frames = createFrameCache(cacheLimits);
  const inFlight = new Map();
  const maps = new Map();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 240,
    globalMax: 2400,
  });
  let listing = null;
  let listingFailedAt = null;

  function coalesced(key, load) {
    return coalesceProxyRequest(inFlight, key, load).promise;
  }

  /** The national directory, shared by every product; last good on failure. */
  async function getListing() {
    if (closed) throw closedError();
    if (listing && now() - listing.fetchedAt < LISTING_TTL_MS)
      return { listing, stale: false };
    const backingOff =
      listingFailedAt !== null && now() - listingFailedAt < LISTING_RETRY_MS;
    if (!backingOff) {
      try {
        const fresh = await coalesced('listing', async () => {
          const names = await getFtp().list(RADAR_DIR);
          const products = parseBomRadarListing(names);
          // A radar directory with no frames is a failed read, not "no rain".
          if (!products.size) throw new Error('empty_listing');
          listing = { products, fetchedAt: now() };
          listingFailedAt = null;
          return listing;
        });
        return { listing: fresh, stale: false };
      } catch (error) {
        if (error?.status === 429) throw error;
        listingFailedAt = now();
      }
    }
    if (listing && now() - listing.fetchedAt < MAX_STALE_MS)
      return { listing, stale: true };
    throw new Error('upstream_unavailable');
  }

  /** Georeferencing for a listed product; cached a day, kept on failure. */
  async function getMap(product) {
    if (closed) throw closedError();
    const previous = maps.get(product);
    if (previous?.value && now() - previous.savedAt < MAP_TTL_MS)
      return previous.value;
    if (
      previous?.failedAt !== undefined &&
      now() - previous.failedAt < MAP_RETRY_MS
    ) {
      if (previous.value) return previous.value;
      throw new Error('map_unavailable');
    }
    try {
      return await coalesced(`map:${product}`, async () => {
        const bytes = await getFtp().download(
          `${MAP_DIR}${product}.map`,
          MAX_MAP_BYTES,
        );
        const value = parseBomRadarMap(bytes.toString('utf8'));
        maps.set(product, { value, savedAt: now() });
        return value;
      });
    } catch (error) {
      maps.set(product, { ...previous, failedAt: now() });
      if (previous?.value) return previous.value;
      throw error;
    }
  }

  async function getFrame(file) {
    if (closed) throw closedError();
    const cached = frames.get(file);
    if (cached) return cached;
    return coalesced(`frame:${file}`, async () => {
      const bytes = await getFtp().download(
        `${RADAR_DIR}${file}`,
        MAX_FRAME_BYTES,
      );
      // An FTP error page or truncated transfer must never reach <img>/Cesium.
      if (!isPng(bytes)) throw new Error('invalid_frame');
      frames.set(file, bytes);
      return bytes;
    });
  }

  const knownMap = (radar) => {
    for (const product of radar.products) {
      const entry = maps.get(product);
      if (entry?.value) return entry.value;
    }
    return null;
  };
  const settled = (radar) =>
    knownMap(radar) !== null ||
    radar.products.every((product) => {
      const entry = maps.get(product);
      return (
        entry?.failedAt !== undefined && now() - entry.failedAt < MAP_RETRY_MS
      );
    });

  /** Fetch one .map per radar that lacks one, sequentially on the shared connection. */
  function warm(radars) {
    return coalesced('warm', async () => {
      let failures = 0;
      for (const radar of radars.slice(0, MAX_WARM_RADARS)) {
        if (closed) break;
        if (settled(radar)) continue;
        // The 128 km product when present; every range of a radar shares its centre.
        const product =
          radar.products.find((id) => id.endsWith('3')) ?? radar.products[0];
        try {
          await getMap(product);
          failures = 0;
        } catch {
          if (closed || ++failures >= WARM_ABORT_AFTER_FAILURES) break;
        }
      }
    });
  }

  async function productsPayload() {
    const { listing: current, stale } = await getListing();
    const radars = groupBomProductsByRadar([...current.products.keys()]);
    if (!radars.every(settled)) {
      const job = warm(radars).catch(() => {});
      let timer;
      await Promise.race([
        job,
        new Promise((resolve) => {
          timer = setTimeout(resolve, warmWaitMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    return {
      radars: radars.map((radar) => {
        const map = knownMap(radar);
        return {
          id: radar.id,
          products: radar.products,
          ...(map ? { center: map.center, name: map.name } : {}),
        };
      }),
      complete: radars.every(settled),
      listedAt: current.fetchedAt,
      ...(stale ? { stale: true } : {}),
    };
  }

  async function framesPayload(product) {
    const { listing: current, stale } = await getListing();
    const available = current.products.get(product);
    if (!available) return { status: 404, body: { error: 'unknown_product' } };
    const map = await getMap(product);
    const recent = newestBomFrames(available, BOM_LOOP_FRAMES);
    return {
      status: 200,
      body: {
        product,
        name: map.name,
        rangeKm: map.rangeKm,
        center: map.center,
        bounds: map.bounds,
        corners: map.corners,
        listedAt: current.fetchedAt,
        frames: recent.map(({ file, timeMs }) => ({
          time: new Date(timeMs).toISOString(),
          url: `/api/bom-radar/frame/${file}`,
        })),
        ...(stale ? { stale: true } : {}),
      },
      stale,
    };
  }

  async function handler(req, res) {
    const send = (status, value, { stale = false } = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    const [path, query = ''] = (req.url || '/').split('?');
    // Status never touches the network or the limiter.
    if (path === '/status')
      return send(200, { enabled: bomRadarEnabled(env()) });
    if (!bomRadarEnabled(env()))
      return send(503, { error: 'bom_radar_disabled' });
    if (closed) return send(502, { error: 'bom_radar_unavailable' });

    let route;
    if (path === '/products') route = 'products';
    else if (path === '/frames') route = 'frames';
    else if (path.startsWith('/frame/')) route = 'frame';
    else return send(404, { error: 'unknown_route' });

    let product;
    let file;
    if (route === 'frames') {
      const values = new URLSearchParams(query).getAll('product');
      product = values[0];
      if (values.length !== 1 || !isBomProduct(product))
        return send(400, { error: 'invalid_product' });
    }
    if (route === 'frame') {
      file = path.slice('/frame/'.length);
      if (!isBomFrameFile(file) || !parseBomFrameName(file))
        return send(400, { error: 'invalid_frame' });
    }
    if (!allow(clientKey(req))) return send(429, { error: 'rate_limited' });

    try {
      if (route === 'products') return send(200, await productsPayload());
      if (route === 'frames') {
        const result = await framesPayload(product);
        return send(result.status, result.body, { stale: result.stale });
      }
      let bytes = frames.get(file);
      if (!bytes) {
        // Only frames the current listing advertises are ever fetched upstream.
        const { listing: current } = await getListing();
        const advertised = current.products
          .get(parseBomFrameName(file).product)
          ?.some((entry) => entry.file === file);
        if (!advertised) return send(404, { error: 'unknown_frame' });
        bytes = await getFrame(file);
      }
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': bytes.length,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(bytes);
    } catch (error) {
      send(error?.status === 429 ? 429 : 502, {
        error: 'bom_radar_unavailable',
      });
    }
  }

  return {
    name: 'bom-radar',
    configureServer({ middlewares, httpServer }) {
      middlewares.use('/api/bom-radar', handler);
      httpServer?.once?.('close', dispose);
    },
    configurePreviewServer({ middlewares, httpServer }) {
      middlewares.use('/api/bom-radar', handler);
      httpServer?.once?.('close', dispose);
    },
    // Backstop for middleware mode, where there is no httpServer to hang 'close' on.
    closeBundle: dispose,
  };
}
