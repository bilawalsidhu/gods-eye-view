import { createLimiter } from '../../limiter.js';
import { msg } from '../../../../i18n/index.js';
import {
  API_CONCURRENCY,
  API_TIMEOUT_MS,
  BUSY_BACKOFF_BASE_SEC,
  MAX_RESPONSE_BYTES,
  NEAREST_BOX_LIMIT,
  NEAREST_FOV_TOLERANCE_DEG,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  PANORAMAX_API,
  PICTURE_TILE_CONCURRENCY,
  STREAM_IDLE_TIMEOUT_MS,
  TILE_CONCURRENCY,
  TILE_TIMEOUT_MS,
} from './policy.js';

/** Longest wait a Retry-After (or the backoff) asks for. */
const RETRY_AFTER_MAX_SEC = 300;

/** An HTTP or API failure; `retryAfterSec` is set while Panoramax is busy. */
export class PanoramaxSourceError extends Error {
  constructor(message, { status = 0, retryAfterSec = null } = {}) {
    super(message);
    this.name = 'PanoramaxSourceError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

const NO_ANSWER = msg('Panoramax did not answer in time — try again');
const UNREACHABLE = msg(
  'Panoramax could not be reached — check the connection',
);

/**
 * Seconds from a Retry-After header (delay seconds or an HTTP date), or
 * null. The meta-catalogue exposes no headers to the browser, so in the
 * app this is usually null and the caller backs off on its own.
 */
export function retryAfterSeconds(response, now = Date.now()) {
  const header = response.headers?.get?.('retry-after');
  if (header == null || header === '') return null;
  let value = Number(header);
  if (!Number.isFinite(value)) {
    const at = Date.parse(header);
    if (!Number.isFinite(at)) return null;
    value = Math.ceil((at - now) / 1000);
  }
  if (value < 0) return null;
  // A maintenance page's hour must not freeze coverage for an hour.
  return Math.min(RETRY_AFTER_MAX_SEC, Math.max(1, value));
}

/**
 * The body as bytes, refusing more than MAX_RESPONSE_BYTES whatever the
 * headers say. `onChunk` hears each piece arrive (the idle timeout).
 */
async function readBounded(response, onChunk = () => {}) {
  const tooMuch = () =>
    new PanoramaxSourceError(msg('Panoramax sent too much data'), {
      status: response.status,
    });
  const length = Number(response.headers?.get?.('content-length'));
  if (length > MAX_RESPONSE_BYTES) throw tooMuch();
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw tooMuch();
    return bytes;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      reader.cancel().catch(() => {});
      throw tooMuch();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Every network path the Panoramax provider uses, browser-side and keyless:
 * the meta-catalogue allows any origin. Vector tiles for coverage and
 * cones, STAC search for single pictures and nearest ones.
 * @param {{fetchImpl?: typeof fetch, api?: string}} [options]
 */
export function createPanoramaxSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  api = PANORAMAX_API,
} = {}) {
  const root = api.replace(/\/+$/, '');
  const apiLimiter = createLimiter(API_CONCURRENCY, { lifo: true });
  const tileLimiter = createLimiter(TILE_CONCURRENCY);
  // The cones' z15 tiles have their own connection: a selection never
  // waits behind coverage tiles.
  const pictureLimiter = createLimiter(PICTURE_TILE_CONCURRENCY, {
    lifo: true,
  });

  /** Busy answers in a row with no readable Retry-After (the backoff grows). */
  let busyStreak = 0;

  /**
   * GET: its headers within `timeoutMs`, then a body that may take as long
   * as it keeps arriving (silent for STREAM_IDLE_TIMEOUT_MS is given up).
   * The caller's abort wins over both.
   */
  async function get(url, { signal, timeoutMs, empty = [] }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) throw signal.reason;
    signal?.addEventListener('abort', onAbort, { once: true });
    const giveUp = () => controller.abort(new PanoramaxSourceError(NO_ANSWER));
    let timer = setTimeout(giveUp, timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (empty.includes(response.status)) {
        busyStreak = 0;
        return null;
      }
      if (response.status === 429 || response.status === 503) {
        const told = retryAfterSeconds(response);
        // Not told how long: back off, longer each time (5, 10, 20… 300 s).
        const wait =
          told ??
          Math.min(
            RETRY_AFTER_MAX_SEC,
            BUSY_BACKOFF_BASE_SEC * 2 ** Math.min(busyStreak, 8),
          );
        busyStreak++;
        throw new PanoramaxSourceError(msg('Panoramax is busy'), {
          status: response.status,
          retryAfterSec: wait,
        });
      }
      if (!response.ok)
        throw new PanoramaxSourceError(
          `Panoramax answered HTTP ${response.status}`,
          { status: response.status },
        );
      busyStreak = 0;
      // The answer has begun: from here only silence is timed.
      clearTimeout(timer);
      timer = setTimeout(giveUp, STREAM_IDLE_TIMEOUT_MS);
      return await readBounded(response, () => {
        clearTimeout(timer);
        timer = setTimeout(giveUp, STREAM_IDLE_TIMEOUT_MS);
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof PanoramaxSourceError) throw error;
      // Offline, or a CORS or TLS failure: not a timeout, not worth a retry.
      throw new PanoramaxSourceError(UNREACHABLE);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * A STAC search, through the API gate (newest request first). One that
   * timed out is asked once more: a search is quick once the connection
   * is free.
   */
  async function search(params, { signal } = {}) {
    const url = `${root}/search?${new URLSearchParams(params)}`;
    const once = () =>
      apiLimiter.run(() => get(url, { signal, timeoutMs: API_TIMEOUT_MS }), {
        signal,
      });
    let bytes;
    try {
      bytes = await once();
    } catch (error) {
      if (signal?.aborted || error?.message !== NO_ANSWER) throw error;
      bytes = await once();
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new PanoramaxSourceError(
        msg('Panoramax sent an unreadable answer'),
      );
    }
    return Array.isArray(payload?.features) ? payload.features : [];
  }

  return {
    api: root,

    /** Raw vector-tile bytes; an empty array where there is no coverage. */
    async getTile({ x, y, z }, { signal, lane = 'coverage' } = {}) {
      const url = `${root}/map/${z}/${x}/${y}.mvt`;
      const gate = lane === 'pictures' ? pictureLimiter : tileLimiter;
      const bytes = await gate.run(
        () =>
          get(url, { signal, timeoutMs: TILE_TIMEOUT_MS, empty: [204, 404] }),
        { signal },
      );
      return bytes ?? new Uint8Array(0);
    },

    /** One picture (a STAC item) by id, or null. */
    async getItem(id, { signal } = {}) {
      const [item] = await search({ ids: String(id), limit: '1' }, { signal });
      return item && String(item.id) === String(id) ? item : null;
    },

    /**
     * Pictures within `radius` metres of a point, unranked: the caller ranks
     * them by distance. Two searches side by side, since neither finds them
     * all: `place_position` (nearest first) leaves out pictures looking
     * away from the point, whatever the tolerance; a bounding box has them,
     * roughly nearest first (not exactly: the caller ranks the union).
     * `collections` keeps one sequence's, `pano` and `sinceMs` filter as
     * the imagery filter does.
     */
    async nearestItems(
      {
        lat,
        lon,
        radius = NEAREST_RADIUS_M,
        limit = NEAREST_LIMIT,
        collections = null,
        pano = 'all',
        sinceMs = null,
      },
      { signal } = {},
    ) {
      const metres = Math.min(1000, Math.max(1, Math.round(radius)));
      const shared = {};
      if (collections) shared.collections = String(collections);
      if (pano === 'pano') shared.filter = 'field_of_view=360';
      else if (pano === 'flat') shared.filter = 'field_of_view<360';
      if (Number.isFinite(sinceMs) && sinceMs > 0)
        shared.datetime = `${new Date(sinceMs).toISOString()}/..`;
      const dLat = metres / 111_320;
      const dLon =
        metres / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
      // Clamped to the map: the API finds nothing in a box past ±180°.
      const box = [
        Math.max(-180, lon - dLon),
        Math.max(-90, lat - dLat),
        Math.min(180, lon + dLon),
        Math.min(90, lat + dLat),
      ].map((v) => v.toFixed(7));
      // One search failing (busy, no answer) leaves the other's pictures;
      // only both failing fails the lookup. The caller's abort stops both.
      const both = new AbortController();
      const onAbort = () => both.abort(signal.reason);
      if (signal?.aborted) throw signal.reason;
      signal?.addEventListener('abort', onAbort, { once: true });
      const run = (params) =>
        search(params, { signal: both.signal }).catch((error) => {
          if (!both.signal.aborted && !signal?.aborted) failures.push(error);
          throw error;
        });
      const failures = [];
      let settled;
      try {
        settled = await Promise.allSettled([
          run({
            place_position: `${Number(lon).toFixed(7)},${Number(lat).toFixed(7)}`,
            place_distance: `0-${metres}`,
            place_fov_tolerance: String(NEAREST_FOV_TOLERANCE_DEG),
            limit: String(Math.min(100, Math.max(1, limit))),
            ...shared,
          }),
          run({
            bbox: box.join(','),
            limit: String(NEAREST_BOX_LIMIT),
            ...shared,
          }),
        ]);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      if (signal?.aborted) throw signal.reason;
      const found = settled
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);
      if (!found.length) throw failures[0] ?? settled[0].reason;
      const byId = new Map();
      for (const item of found.flat())
        if (item?.id != null && !byId.has(String(item.id)))
          byId.set(String(item.id), item);
      return [...byId.values()];
    },
  };
}
