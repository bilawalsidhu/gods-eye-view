import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  normalizeParkingContributors,
  normalizeParkingPage,
} from './records.js';

/** MobiData BW's public ParkAPI v3: keyless, CORS `*`, browser-direct. */
export const PARKING_API_ROOT =
  'https://api.mobidata-bw.de/park-api/api/public/v3';

/**
 * Sites asked for per view. A Stuttgart city-centre view holds about 80 car
 * parks and garages; ParkAPI accepts at most 1,000 per page. A read that
 * reports more than it returned is `saturated`.
 */
export const PARKING_SITE_LIMIT = 500;

/**
 * The widest view read, in degrees of latitude (about 44 km). A wider view
 * asks to zoom in before any request instead of reading a sample.
 */
export const PARKING_MAX_SPAN_DEG = 0.4;

/** View boxes snap outward to this grid, so a small pan repeats a cached read. */
const GRID_DEG = 0.02;
/** A read is reused for a minute; the layer polls every five. */
const READ_TTL_MS = 60_000;
const READ_CACHE_SIZE = 16;
/** The contributor list changes when a source joins; refetch twice a day. */
const CONTRIBUTOR_TTL_MS = 12 * 60 * 60 * 1000;
/** 500 sites are about 350 KB of JSON; anything past this is not a page. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Whether `box` is narrow enough to read.
 * @param {{south:number, west:number, north:number, east:number}} box View box.
 * @returns {boolean} True when the view can load.
 */
export function parkingViewFits(box) {
  const middle = ((box.south + box.north) / 2) * (Math.PI / 180);
  return (
    box.north - box.south <= PARKING_MAX_SPAN_DEG &&
    (box.east - box.west) * Math.cos(middle) <= PARKING_MAX_SPAN_DEG
  );
}

function validBox(box) {
  return (
    box &&
    [box.south, box.west, box.north, box.east].every(Number.isFinite) &&
    box.south < box.north &&
    box.west < box.east &&
    box.south >= -90 &&
    box.north <= 90 &&
    box.west >= -180 &&
    box.east <= 180
  );
}

/** The request box: `box` grown to the grid, as fixed decimal text. */
function gridBox(box) {
  // The epsilon keeps a box edge already on the grid (48.76) from snapping a
  // whole cell outward through floating-point division.
  const down = (value) =>
    (Math.floor(value / GRID_DEG + 1e-9) * GRID_DEG).toFixed(2);
  const up = (value) =>
    (Math.ceil(value / GRID_DEG - 1e-9) * GRID_DEG).toFixed(2);
  return {
    lat_min: down(box.south),
    lat_max: up(box.north),
    lon_min: down(box.west),
    lon_max: up(box.east),
  };
}

/**
 * Name the upstream in the fixed forms the layer row translates
 * (`translateFeedError`), never with raw transport or decoder text.
 */
function parkingFeedError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const message =
    status === 429
      ? 'ParkAPI rate limited'
      : status
        ? `ParkAPI HTTP ${status}`
        : error?.name === 'TimeoutError' || error instanceof TypeError
          ? 'ParkAPI network error'
          : 'Malformed ParkAPI response';
  return Object.assign(new Error(message, { cause: error }), { status });
}

/**
 * Read car parks and parking garages from ParkAPI v3 for one bounded view:
 * `purpose=CAR`, kerbside `ON_STREET` segments left out, duplicates merged by
 * ParkAPI (its default). Coverage is the sources MobiData BW bundles, mostly
 * Baden-Württemberg; elsewhere a read is honestly empty.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] Injected fetch, for tests.
 * @param {() => number} [options.now] Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] Deadline for each request.
 * @returns {{getSites: Function, destroy: Function, label: string,
 *   attribution: object}} Source.
 */
export function createParkingSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  /** url -> { at, page } */
  const reads = new Map();
  let contributors = new Map();
  let contributorsAt = -Infinity;

  async function getJson(url, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error('ParkAPI request timed out'), {
            name: 'TimeoutError',
          }),
        ),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (error) {
        throw controller.signal.aborted && !signal?.aborted
          ? controller.signal.reason
          : error;
      }
      if (!response.ok)
        throw Object.assign(new Error(`HTTP ${response.status}`), {
          status: response.status,
        });
      return await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  /** Who each source asks to be named; a failed read names nobody. */
  async function readContributors(signal) {
    if (now() - contributorsAt < CONTRIBUTOR_TTL_MS) return contributors;
    try {
      contributors = normalizeParkingContributors(
        await getJson(`${PARKING_API_ROOT}/sources`, signal),
      );
      contributorsAt = now();
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return contributors;
  }

  return {
    /**
     * @param {{south:number, west:number, north:number, east:number}} box View box.
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{records: Array<object>, zoomIn: boolean,
     *   partial: boolean, saturated: boolean, observedAt: number|null}>}
     *   `observedAt` is the newest live reading among the records.
     */
    async getSites(box, { signal } = {}) {
      if (!validBox(box))
        throw new TypeError('Parking requires a bounded viewport');
      signal?.throwIfAborted();
      if (!parkingViewFits(box))
        return {
          records: [],
          zoomIn: true,
          partial: false,
          saturated: false,
          observedAt: null,
        };
      const query = new URLSearchParams({
        ...gridBox(box),
        purpose: 'CAR',
        not_type: 'ON_STREET',
        limit: String(PARKING_SITE_LIMIT),
      });
      const url = `${PARKING_API_ROOT}/parking-sites?${query}`;
      let page = reads.get(url);
      if (!page || now() - page.at > READ_TTL_MS) {
        let payload, named;
        try {
          [payload, named] = await Promise.all([
            getJson(url, signal),
            readContributors(signal),
          ]);
        } catch (error) {
          if (error?.name === 'AbortError' || signal?.aborted) throw error;
          throw parkingFeedError(error);
        }
        const decoded = normalizeParkingPage(payload);
        if (!decoded) throw parkingFeedError(null);
        page = {
          at: now(),
          ...decoded,
          records: decoded.records.map((record) => ({
            ...record,
            contributor: named.get(record.sourceId) ?? null,
          })),
        };
        reads.delete(url);
        reads.set(url, page);
        while (reads.size > READ_CACHE_SIZE)
          reads.delete(reads.keys().next().value);
      }
      signal?.throwIfAborted();
      const updated = page.records
        .map((record) => record.updatedAt)
        .filter(Number.isFinite);
      return {
        records: page.records,
        zoomIn: false,
        partial: false,
        saturated: page.total > page.returned,
        observedAt: updated.length ? Math.max(...updated) : null,
      };
    },
    destroy() {
      reads.clear();
    },
    // i18n-ignore: provider and service names stay as published
    label: 'MobiData BW · ParkAPI',
    attribution: {
      name: 'MobiData BW',
      description: 'MobiData BW · ParkAPI, dl-de/by-2-0',
      text: 'MobiData BW · ParkAPI, dl-de/by-2-0',
      href: 'https://www.mobidata-bw.de/dataset/gebuendelte-parkdaten-bw',
    },
  };
}
