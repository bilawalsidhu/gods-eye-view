import {
  readResponseTextCapped,
  readResponseBytesCapped,
  coalesceProxyRequest,
} from './common/http.js';

const HKO_ORIGIN = 'https://www.hko.gov.hk';
const KML_PATH = '/wxinfo/radars/R4_GIS_rad_128/R4_GIS_server_Radar_128.kml';
const FRAME_DIR = '/wxinfo/radars/R4_GIS_rad_128/';
const PRODUCT = 'radar-128';
const FRAME_NAME = /^\d{14}_rad_128\.png$/;
const MAX_KML_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const KML_TTL_MS = 150_000;
const MAX_FRAMES = 32;
const ATTRIBUTION = 'Hong Kong Observatory / DATA.GOV.HK';
const COVERAGE =
  'Hong Kong and vicinity · 128 km radar mosaic; not a rainfall nowcast.';

function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

/** Parse `YYYYMMDDHHmmss_rad_128.png` as an explicit UTC observation time. */
export function hkoRadarFrameTime(name) {
  if (typeof name !== 'string' || !FRAME_NAME.test(name)) return null;
  const stamp = name.slice(0, 14);
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}.000Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== iso) return null;
  return iso;
}

/** Accept only a same-directory basename for the pinned 128 km product. */
export function hkoRadarFrameName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return FRAME_NAME.test(name) &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..')
    ? name
    : null;
}

function bound(value, low, high) {
  if (typeof value !== 'string') return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= low && n <= high ? n : null;
}

/**
 * Extract GroundOverlay frames from HKO radar KML without entity expansion.
 * Only Icon hrefs matching the 128 km basename grammar are accepted.
 */
export function parseHkoRadarKml(kml) {
  if (
    typeof kml !== 'string' ||
    !kml ||
    kml.length > MAX_KML_BYTES ||
    /<!DOCTYPE|<!ENTITY/i.test(kml)
  )
    throw failure('invalid_hko_radar_kml', 502);
  const frames = [];
  let tags = 0;
  for (const match of kml.matchAll(
    /<GroundOverlay\b[^>]*>([\s\S]*?)<\/GroundOverlay>/g,
  )) {
    if (++tags > 64) throw failure('invalid_hko_radar_kml', 502);
    const body = match[1];
    const rawHref = body
      .match(/<Icon\b[^>]*>\s*<href\s*>([^<]*)<\/href>/i)?.[1]
      ?.trim();
    const name = hkoRadarFrameName(rawHref);
    if (!name) continue;
    const time = hkoRadarFrameTime(name);
    if (!time) continue;
    const box = body.match(/<LatLonBox\b[^>]*>([\s\S]*?)<\/LatLonBox>/i)?.[1];
    if (!box) continue;
    const north = bound(box.match(/<north\s*>([^<]*)<\/north>/i)?.[1], -90, 90);
    const south = bound(box.match(/<south\s*>([^<]*)<\/south>/i)?.[1], -90, 90);
    const east = bound(box.match(/<east\s*>([^<]*)<\/east>/i)?.[1], -180, 180);
    const west = bound(box.match(/<west\s*>([^<]*)<\/west>/i)?.[1], -180, 180);
    if (
      north === null ||
      south === null ||
      east === null ||
      west === null ||
      west >= east ||
      south >= north
    )
      continue;
    frames.push({
      time,
      href: name,
      extent: Object.freeze({ west, south, east, north }),
    });
  }
  if (!frames.length) throw failure('invalid_hko_radar_kml', 502);
  frames.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const deduped = [];
  const seen = new Set();
  for (const frame of frames) {
    if (seen.has(frame.href)) continue;
    seen.add(frame.href);
    deduped.push(frame);
  }
  if (deduped.length > MAX_FRAMES)
    deduped.splice(0, deduped.length - MAX_FRAMES);
  const extent = deduped.at(-1).extent;
  for (const frame of deduped) {
    const e = frame.extent;
    if (
      e.west !== extent.west ||
      e.south !== extent.south ||
      e.east !== extent.east ||
      e.north !== extent.north
    )
      throw failure('invalid_hko_radar_kml', 502);
  }
  return Object.freeze({
    product: PRODUCT,
    extent,
    frames: Object.freeze(
      deduped.map(({ time, href }) => Object.freeze({ time, href })),
    ),
    latest: deduped.at(-1).time,
    attribution: ATTRIBUTION,
    coverage: COVERAGE,
  });
}

function sameHkoHost(url) {
  return (
    url.origin === HKO_ORIGIN &&
    url.protocol === 'https:' &&
    !url.port &&
    !url.username &&
    !url.password
  );
}

/** Follow at most one same-host redirect for pinned HKO radar assets. */
async function fetchHkoPinned(fetchImpl, url, signal, { accept }) {
  let response = await fetchImpl(url.href, {
    signal,
    redirect: 'manual',
    headers: { Accept: accept },
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || /\.\.|[?%\\]/.test(location))
      throw failure('invalid_hko_radar_redirect', 502);
    const next = new URL(location, url);
    if (!sameHkoHost(next) || next.pathname !== url.pathname)
      throw failure('invalid_hko_radar_redirect', 502);
    next.search = '';
    next.hash = '';
    response = await fetchImpl(next.href, {
      signal,
      redirect: 'error',
      headers: { Accept: accept },
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw failure('hko_radar_upstream_unavailable');
  }
  return response;
}

/** Fixed-origin HKO 128 km rain radar KML + PNG proxy. */
export function hkoRadarProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  const inFlight = new Map();

  async function loadManifest(signal) {
    const url = new URL(KML_PATH, HKO_ORIGIN);
    const response = await fetchHkoPinned(fetchImpl, url, signal, {
      accept:
        'application/vnd.google-earth.kml+xml,application/xml,text/xml,*/*',
    });
    const text = await readResponseTextCapped(response, MAX_KML_BYTES, signal);
    return parseHkoRadarKml(text);
  }

  async function manifest(signal) {
    if (cached && now() - cached.savedAt < KML_TTL_MS)
      return { value: cached.value, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'kml', async () => {
        const value = await loadManifest(signal);
        cached = { value, savedAt: now() };
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (cached) return { value: cached.value, stale: true };
      throw error;
    }
  }

  async function frameBytes(name, signal) {
    const url = new URL(`${FRAME_DIR}${name}`, HKO_ORIGIN);
    const response = await fetchHkoPinned(fetchImpl, url, signal, {
      accept: 'image/png',
    });
    const type = response.headers.get('content-type') || '';
    if (type && !/^image\/png(?:;|$)/i.test(type)) {
      await response.body?.cancel();
      throw failure('invalid_hko_radar_frame', 502);
    }
    return readResponseBytesCapped(response, MAX_FRAME_BYTES, signal);
  }

  function json(
    res,
    status,
    value,
    { stale = false, cache = 'no-store' } = {},
  ) {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      ...(status === 405 ? { Allow: 'GET' } : {}),
      ...(stale ? { 'X-Data-Stale': 'true' } : {}),
    });
    res.end(JSON.stringify(value));
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const controller = new AbortController();
    const close = () => controller.abort();
    res.on?.('close', close);
    try {
      if (path === '/' || path === '') {
        const { value, stale } = await manifest(controller.signal);
        const frames = value.frames.map((frame) =>
          Object.freeze({
            time: frame.time,
            href: frame.href,
            url: `/api/hko-radar/frame?name=${encodeURIComponent(frame.href)}`,
          }),
        );
        return json(
          res,
          200,
          {
            schemaVersion: 1,
            product: value.product,
            extent: value.extent,
            frames,
            latest: value.latest,
            attribution: value.attribution,
            coverage: value.coverage,
            stale,
          },
          {
            stale,
            cache: 'public, max-age=60',
          },
        );
      }
      if (path === '/frame') {
        const name = hkoRadarFrameName(url.searchParams.get('name'));
        if (!name) return json(res, 400, { error: 'invalid_hko_radar_frame' });
        const bytes = await frameBytes(name, controller.signal);
        if (res.destroyed) return;
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=120',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(Buffer.from(bytes));
        return;
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      if (!controller.signal.aborted)
        json(
          res,
          error.status === 400 || error.status === 502 ? error.status : 503,
          {
            error:
              error.status === 400 || error.status === 502
                ? error.code
                : 'hko_radar_upstream_unavailable',
          },
        );
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'hko-radar',
    configureServer({ middlewares }) {
      middlewares.use('/api/hko-radar', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/hko-radar', handler);
    },
  };
}
