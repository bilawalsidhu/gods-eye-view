import { readResponseJsonCapped } from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

const MAPILLARY_CACHE_MS = 5 * 60_000;
const MAPILLARY_MAX_CACHE = 64;
const MAPILLARY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAPILLARY_UPSTREAM_TIMEOUT_MS = 15_000;
const MAPILLARY_RESULT_LIMIT = 200;
const MAPILLARY_MAX_BBOX_AREA = 0.01;

/** Validate the small non-dateline bbox accepted by Mapillary's Graph API. */
export function validMapillaryBox(params) {
  const west = Number(params.get('west'));
  const south = Number(params.get('south'));
  const east = Number(params.get('east'));
  const north = Number(params.get('north'));
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90) return null;
  if (east <= west || north <= south) return null;
  if ((east - west) * (north - south) >= MAPILLARY_MAX_BBOX_AREA) return null;
  return { west, south, east, north };
}

/** Map the small public filter vocabulary to a stable Graph API lower bound. */
export function mapillaryStartCapturedAt(range, now = Date.now()) {
  if (range === 'all') return null;
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  if (range === '30d') date.setUTCDate(date.getUTCDate() - 30);
  else if (range === '12m') date.setUTCFullYear(date.getUTCFullYear() - 1);
  else return undefined;
  return date.toISOString();
}

function cleanMapillaryText(value, maxLength = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function validMapillaryGeometry(value) {
  const longitude = Number(value?.coordinates?.[0]);
  const latitude = Number(value?.coordinates?.[1]);
  if (
    value?.type !== 'Point' ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude)
  )
    return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)
    return null;
  return { type: 'Point', coordinates: [longitude, latitude] };
}

/** Reduce an upstream image entity to the fields the browser layer consumes. */
export function normalizeMapillaryProxyImage(raw) {
  const id = cleanMapillaryText(raw?.id, 40);
  const computedGeometry = validMapillaryGeometry(raw?.computed_geometry);
  const geometry = validMapillaryGeometry(raw?.geometry);
  if (!id || (!computedGeometry && !geometry)) return null;
  const capturedAt = Number(raw?.captured_at);
  const computedCompass = Number(raw?.computed_compass_angle);
  const compass = Number(raw?.compass_angle);
  const thumbnail1024 = cleanMapillaryText(raw?.thumb_1024_url, 2048);
  const thumbnail256 = cleanMapillaryText(raw?.thumb_256_url, 2048);
  const cameraType = cleanMapillaryText(raw?.camera_type, 40).toLowerCase();
  const make = cleanMapillaryText(raw?.make, 80);
  const model = cleanMapillaryText(raw?.model, 120);
  const creator =
    raw?.creator && typeof raw.creator === 'object'
      ? {
          id: cleanMapillaryText(raw.creator.id, 40) || undefined,
          username:
            cleanMapillaryText(raw.creator.username || raw.creator.name, 120) ||
            undefined,
        }
      : undefined;
  return {
    id,
    ...(computedGeometry ? { computed_geometry: computedGeometry } : {}),
    ...(geometry ? { geometry } : {}),
    ...(Number.isFinite(capturedAt) && capturedAt > 0
      ? { captured_at: capturedAt }
      : {}),
    ...(Number.isFinite(computedCompass)
      ? { computed_compass_angle: computedCompass }
      : {}),
    ...(Number.isFinite(compass) ? { compass_angle: compass } : {}),
    ...(creator && (creator.id || creator.username) ? { creator } : {}),
    ...(/^https:\/\//i.test(thumbnail1024)
      ? { thumb_1024_url: thumbnail1024 }
      : {}),
    ...(/^https:\/\//i.test(thumbnail256)
      ? { thumb_256_url: thumbnail256 }
      : {}),
    ...(cameraType ? { camera_type: cameraType } : {}),
    ...(make ? { make } : {}),
    ...(model ? { model } : {}),
  };
}

export function mapillaryRetryAfterSec(value) {
  const seconds = Number(String(value || '').trim());
  if (!Number.isFinite(seconds)) return 30;
  return Math.max(1, Math.min(300, Math.ceil(seconds)));
}

/** Bounded, cached Mapillary metadata proxy with a server-held access token. */
export function mapillaryProxy() {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });
  let upstreamCooldownUntil = 0;

  const trimCache = () => {
    while (cache.size > MAPILLARY_MAX_CACHE)
      cache.delete(cache.keys().next().value);
  };

  const install = (middlewares) => {
    middlewares.use('/api/mapillary/images', async (req, res) => {
      const sendJson = (status, body, extraHeaders = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...extraHeaders,
        });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') {
        sendJson(405, { error: 'method_not_allowed' });
        return;
      }
      const token = String(process.env.MAPILLARY_ACCESS_TOKEN || '').trim();
      if (!token) {
        sendJson(503, { error: 'no_key' });
        return;
      }
      const requestUrl = new URL(req.url, 'http://localhost');
      const box = validMapillaryBox(requestUrl.searchParams);
      if (!box) {
        sendJson(400, { error: 'invalid_bbox' });
        return;
      }
      const range = requestUrl.searchParams.get('range') || 'all';
      const startCapturedAt = mapillaryStartCapturedAt(range);
      if (startCapturedAt === undefined) {
        sendJson(400, { error: 'invalid_range' });
        return;
      }
      const cacheKey = `${[box.west, box.south, box.east, box.north]
        .map((value) => value.toFixed(5))
        .join(',')}|${range}`;
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < MAPILLARY_CACHE_MS) {
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        sendJson(
          200,
          { ...cached.payload, status: 'cached' },
          { 'X-Mapillary-Cache': 'HIT' },
        );
        return;
      }
      if (Date.now() < upstreamCooldownUntil) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil((upstreamCooldownUntil - Date.now()) / 1000),
        );
        sendJson(
          429,
          { error: 'rate_limited', retryAfterSec },
          { 'Retry-After': String(retryAfterSec) },
        );
        return;
      }

      let request = inFlight.get(cacheKey);
      let shared = true;
      if (!request) {
        shared = false;
        if (!allow(clientKey(req))) {
          sendJson(
            429,
            { error: 'rate_limited', retryAfterSec: 5 },
            { 'Retry-After': '5' },
          );
          return;
        }
        request = (async () => {
          const upstreamUrl = new URL('https://graph.mapillary.com/images');
          upstreamUrl.searchParams.set(
            'bbox',
            `${box.west},${box.south},${box.east},${box.north}`,
          );
          upstreamUrl.searchParams.set('limit', String(MAPILLARY_RESULT_LIMIT));
          if (startCapturedAt)
            upstreamUrl.searchParams.set('start_captured_at', startCapturedAt);
          upstreamUrl.searchParams.set(
            'fields',
            [
              'id',
              'computed_geometry',
              'geometry',
              'captured_at',
              'computed_compass_angle',
              'compass_angle',
              'creator',
              'camera_type',
              'make',
              'model',
              'thumb_1024_url',
              'thumb_256_url',
            ].join(','),
          );
          const upstream = await fetch(upstreamUrl, {
            headers: { Authorization: `OAuth ${token}` },
            signal: AbortSignal.timeout(MAPILLARY_UPSTREAM_TIMEOUT_MS),
          });
          if (upstream.status === 429) {
            const retryAfterSec = mapillaryRetryAfterSec(
              upstream.headers.get('retry-after'),
            );
            upstreamCooldownUntil = Date.now() + retryAfterSec * 1000;
            const error = new Error('Mapillary rate limited');
            error.code = 'RATE_LIMITED';
            error.retryAfterSec = retryAfterSec;
            throw error;
          }
          if (!upstream.ok) {
            const error = new Error(`Mapillary HTTP ${upstream.status}`);
            error.code = 'UPSTREAM';
            throw error;
          }
          const body = await readResponseJsonCapped(
            upstream,
            MAPILLARY_MAX_RESPONSE_BYTES,
          );
          const rows = Array.isArray(body?.data) ? body.data : null;
          if (!rows) {
            const error = new Error('Malformed Mapillary response');
            error.code = 'UPSTREAM';
            throw error;
          }
          const images = rows.map(normalizeMapillaryProxyImage).filter(Boolean);
          const payload = {
            fetchedAt: Date.now(),
            status: 'fresh',
            saturated: rows.length >= MAPILLARY_RESULT_LIMIT,
            images,
          };
          cache.set(cacheKey, { cachedAt: Date.now(), payload });
          trimCache();
          return payload;
        })().finally(() => {
          if (inFlight.get(cacheKey) === request) inFlight.delete(cacheKey);
        });
        inFlight.set(cacheKey, request);
      }

      try {
        const payload = await request;
        sendJson(200, payload, {
          'X-Mapillary-Cache': shared ? 'INFLIGHT' : 'MISS',
        });
      } catch (error) {
        if (error?.code === 'RATE_LIMITED') {
          sendJson(
            429,
            { error: 'rate_limited', retryAfterSec: error.retryAfterSec },
            { 'Retry-After': String(error.retryAfterSec) },
          );
          return;
        }
        console.warn(
          '[mapillary-proxy] request failed:',
          error?.message || error,
        );
        sendJson(502, {
          error:
            error?.code === 'RESPONSE_TOO_LARGE'
              ? 'response_too_large'
              : 'upstream',
        });
      }
    });
  };

  return {
    name: 'mapillary-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
