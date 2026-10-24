import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeFloodSeries, normalizeRiverPoint } from './records.js';
// A portable export (package.json): it marks text and loads no catalogs. The
// layer row translates the source label and the fixed error forms below.
import { msg } from '../../i18n/marker.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function retryDelayMs(raw) {
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(3_600_000, Math.max(5_000, seconds * 1000))
    : null;
}

/**
 * Name the upstream in the fixed forms the layer row translates
 * (`translateFeedError`), never with raw transport or decoder text.
 */
function feedError(
  message,
  { status = null, retryAfterMs = null, cause } = {},
) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    status,
    retryable: status === null || status === 429 || status >= 500,
    retryAfterMs,
  });
}

/** Four decimals: the proxy's box grammar, and no false precision. */
const boxParam = (value) => String(Math.round(value * 1e4) / 1e4);

/**
 * Read the river discharge outlook for one view box through the same-origin
 * `/api/river-discharge` proxy. The box selects bundled points; the browser
 * never names an upstream.
 */
export function createRiverDischargeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @param {{south:number, west:number, north:number, east:number}} box
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{today: string, fetchedAt: number|null, total: number,
     *   partial: boolean, stale: boolean, points: Array<object>}>}
     */
    async getOutlook(box, { signal } = {}) {
      signal?.throwIfAborted();
      const keys = ['south', 'west', 'north', 'east'];
      if (!keys.every((key) => Number.isFinite(box?.[key])))
        throw new TypeError('River discharge outlook needs a view box');
      const params = new URLSearchParams(
        keys.map((key) => [key, boxParam(box[key])]),
      );
      let response;
      try {
        response = await fetchImpl(`/api/river-discharge?${params}`, {
          signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        throw feedError('Open-Meteo network error', { cause: error });
      }
      if (!response.ok) {
        await response.body?.cancel?.();
        const status = response.status;
        const retryAfterMs = retryDelayMs(response.headers.get('retry-after'));
        throw feedError(
          status === 429
            ? 'Open-Meteo rate limited'
            : `Open-Meteo HTTP ${status}`,
          {
            status,
            retryAfterMs: retryAfterMs ?? (status === 429 ? 60_000 : null),
          },
        );
      }
      let payload;
      try {
        payload = await readResponseJsonCapped(
          response,
          MAX_RESPONSE_BYTES,
          signal,
        );
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        throw feedError('Malformed Open-Meteo response', { cause: error });
      }
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.points) || !ISO_DAY.test(payload?.today))
        throw feedError('Malformed Open-Meteo response');
      const points = [];
      for (const row of payload.points) {
        const point = normalizeRiverPoint(row);
        const series = normalizeFloodSeries({
          daily: row?.series && {
            time: row.series.time,
            river_discharge: row.series.discharge,
            river_discharge_median: row.series.median,
            river_discharge_min: row.series.min,
            river_discharge_max: row.series.max,
            river_discharge_p25: row.series.p25,
            river_discharge_p75: row.series.p75,
          },
        });
        if (point && series) points.push({ ...point, series });
      }
      const years = ['start', 'end'].map((key) =>
        ISO_DAY.test(payload.climatology?.[key] || '')
          ? payload.climatology[key].slice(0, 4)
          : null,
      );
      return {
        today: payload.today,
        climatology: years.every(Boolean)
          ? { from: years[0], to: years[1] }
          : null,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        total: Number.isInteger(payload.total) ? payload.total : points.length,
        partial:
          payload.partial === true || points.length < payload.points.length,
        stale: payload.stale === true,
        points,
      };
    },
    label: msg('Open-Meteo · GloFAS model'),
    attribution: {
      name: 'Open-Meteo',
      description: 'River discharge data by Open-Meteo.com (CC BY 4.0), GloFAS',
      href: 'https://open-meteo.com/',
    },
  };
}
