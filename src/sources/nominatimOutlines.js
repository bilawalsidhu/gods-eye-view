import { readResponseJsonCapped } from './httpBody.js';

/**
 * Browser client for the server's guarded outline route. The server owns the
 * endpoint, pacing, caps and caches; this client only asks once per explicit
 * voice ask and reads the tri-state answer the annotation resolver expects:
 *
 *   - `{ polygons, name, class, type, osm }` — an accepted outline;
 *   - `null` — the service answered and has no suitable polygon;
 *   - `undefined` — a transient failure; a later retry may succeed;
 *   - `{ rateLimited: true, retryAfterMs }` — busy; retry no sooner;
 *   - `{ unavailable: true, retryable: false }` — disabled, capped for the
 *     day, or no route: stop asking this session.
 */

const DEFAULT_ENDPOINT = '/api/geocode/outline';
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** Ask kinds the route accepts. */
export const NOMINATIM_OUTLINE_KINDS = Object.freeze([
  'city',
  'admin',
  'neighborhood',
  'landmark',
  'building',
]);

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const out = [];
  for (const point of ring) {
    const lon = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) return null;
    out.push([lon, lat]);
  }
  return out;
}

function validPolygons(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const polygons = [];
  for (const rings of value) {
    if (!Array.isArray(rings)) continue;
    const clean = rings.map(validRing);
    // The outer ring must be valid; invalid holes are dropped.
    if (clean[0]) polygons.push(clean.filter(Boolean));
  }
  return polygons.length ? polygons : null;
}

export function createNominatimOutlineClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = DEFAULT_ENDPOINT,
  maxRemembered = 64,
} = {}) {
  let unavailable = null;
  const remembered = new Map();

  function remember(key, value) {
    remembered.delete(key);
    remembered.set(key, value);
    while (remembered.size > maxRemembered)
      remembered.delete(remembered.keys().next().value);
  }

  /**
   * @param {{query: string, kind: string, lat?: number, lon?: number}} ask
   * @param {{signal?: AbortSignal}} [options]
   */
  async function lookup({ query, kind, lat, lon }, { signal } = {}) {
    if (unavailable) return unavailable;
    const text = String(query || '').trim();
    if (!text || text.length > 200 || !NOMINATIM_OUTLINE_KINDS.includes(kind))
      return null;
    const params = new URLSearchParams({ q: text, kind });
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      params.set('lat', lat.toFixed(3));
      params.set('lon', lon.toFixed(3));
    }
    const key = params.toString();
    if (remembered.has(key)) return remembered.get(key);
    // A cancelled ask spends nothing.
    signal?.throwIfAborted();

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${endpoint}?${key}`, {
        signal: controller.signal,
      });
      let body = null;
      try {
        body = await readResponseJsonCapped(
          response,
          MAX_RESPONSE_BYTES,
          controller.signal,
        );
      } catch {
        body = null;
      }
      if (response.status === 404 || body?.retryable === false) {
        // No outline route here, disabled, or today's allowance is used.
        unavailable = { unavailable: true, retryable: false, code: body?.code };
        return unavailable;
      }
      if (response.status === 429) {
        const seconds = Number(response.headers?.get?.('retry-after'));
        return {
          rateLimited: true,
          retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : null,
        };
      }
      if (!response.ok || !body) return undefined;
      if (body.status === 'ZERO_RESULTS') {
        remember(key, null);
        return null;
      }
      const polygons = validPolygons(body.outline?.polygons);
      if (body.status !== 'OK' || !polygons) return undefined;
      const outline = {
        polygons,
        name: body.outline.name || null,
        class: body.outline.class || null,
        type: body.outline.type || null,
        osm: body.outline.osm || null,
      };
      remember(key, outline);
      return outline;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  return { lookup };
}
