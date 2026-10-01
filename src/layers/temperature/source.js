import { recentMonths, yearMonths } from './dates.js';
import {
  FIRST_YEAR,
  GIBS_LAYER,
  GIBS_TILE_MATRIX_SET,
  LATEST_LOOKBACK_MONTHS,
  PROBE_CONCURRENCY,
  PROBE_TILE,
} from './policy.js';

/** @param {string} date First-of-month time key. @returns {string} Probe tile URL. */
export function probeTileUrl(date) {
  const { level, row, col } = PROBE_TILE;
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_LAYER}/default/${date}/${GIBS_TILE_MATRIX_SET}/${level}/${row}/${col}.png`;
}

function unavailable(message) {
  return Object.assign(new Error(message), { failureReason: 'unavailable' });
}

/**
 * Resolve published monthly means from GIBS.
 *
 * GIBS answers an unpublished month with 404 rather than an empty tile, so
 * Cesium cannot discover this for us — an unpublished month yields a silent,
 * wholly blank frame. One cheap tile probe per candidate settles it before any
 * provider is constructed.
 * @param {{probeImpl:Function}} options Injected tile probe; see ./probe.js for the
 *   browser implementation, which this module cannot hold because it is a
 *   portable export and may not touch browser globals.
 * @returns {{resolveLatest:Function, resolveYear:Function}} Temperature frame source.
 */
export function createTemperatureSource({ probeImpl } = {}) {
  if (typeof probeImpl !== 'function')
    throw new TypeError('A tile availability probe is required');
  return {
    /**
     * The newest published month.
     * @param {{now?:number, months?:number, signal?:AbortSignal}} [options]
     * @returns {Promise<{date:string, candidatesTried:number}>}
     */
    async resolveLatest({
      now = Date.now(),
      months = LATEST_LOOKBACK_MONTHS,
      signal,
    } = {}) {
      const candidates = recentMonths(now, months);
      for (const date of candidates) {
        signal?.throwIfAborted();
        const available = await probeImpl(probeTileUrl(date), { signal });
        signal?.throwIfAborted();
        if (available)
          return { date, candidatesTried: candidates.indexOf(date) + 1 };
      }
      throw unavailable(
        `No monthly temperature mean reachable in the last ${candidates.length} months`,
      );
    },

    /**
     * The published months of one calendar year, oldest first.
     *
     * Probes in small parallel batches, so a month missing from the record
     * drops out of the year rather than playing as a blank frame.
     * @param {{year:number, latest:string, signal?:AbortSignal}} options
     * @returns {Promise<{year:number, dates:Array<string>}>}
     */
    async resolveYear({ year, latest, signal } = {}) {
      const latestYear = Number(String(latest).slice(0, 4));
      if (!Number.isInteger(year) || year < FIRST_YEAR || year > latestYear)
        throw new RangeError(`No monthly means for year ${year}`);
      const candidates = yearMonths(year, latest);
      const found = [];
      for (
        let start = 0;
        start < candidates.length;
        start += PROBE_CONCURRENCY
      ) {
        signal?.throwIfAborted();
        const batch = candidates.slice(start, start + PROBE_CONCURRENCY);
        const results = await Promise.all(
          batch.map((date) => probeImpl(probeTileUrl(date), { signal })),
        );
        signal?.throwIfAborted();
        batch.forEach((date, index) => {
          if (results[index]) found.push(date);
        });
      }
      if (!found.length)
        throw unavailable(`No monthly temperature means reachable for ${year}`);
      return { year, dates: found };
    },
  };
}
