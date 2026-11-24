import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  parseKp,
  parseOvation,
  parseScales,
  parseSolarWind,
} from './records.js';

// A portable export: no i18n here. Failures stay English data; the Layers
// panel shows them translated (ui/statusText.js matches "<source> HTTP <n>").

/** NOAA SWPC answers browsers directly (CORS `*`), keyless. */
export const SWPC_ORIGIN = 'https://services.swpc.noaa.gov';
export const SWPC_PATHS = Object.freeze({
  ovation: '/json/ovation_aurora_latest.json',
  kp: '/products/noaa-planetary-k-index.json',
  scales: '/products/noaa-scales.json',
  speed: '/products/summary/solar-wind-speed.json',
  field: '/products/summary/solar-wind-mag-field.json',
});
// The OVATION grid is about 0.9 MB; the summaries are a few KB.
const OVATION_BYTES = 4 * 1024 * 1024;
const SUMMARY_BYTES = 256 * 1024;

/**
 * NOAA SWPC aurora and space-weather snapshots. The OVATION grid is required;
 * Kp, the NOAA scales and the solar wind are each optional, null when their
 * product fails.
 */
export function createAuroraSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  origin = SWPC_ORIGIN,
} = {}) {
  async function read(path, maxBytes, signal) {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw Object.assign(new Error('NOAA SWPC network error'), {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok)
      throw Object.assign(new Error(`NOAA SWPC HTTP ${response.status}`), {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    return readResponseJsonCapped(response, maxBytes, signal);
  }
  const optional = (path, signal) =>
    read(path, SUMMARY_BYTES, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return null;
    });

  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const [ovation, kp, scales, speed, field] = await Promise.all([
        read(SWPC_PATHS.ovation, OVATION_BYTES, signal),
        optional(SWPC_PATHS.kp, signal),
        optional(SWPC_PATHS.scales, signal),
        optional(SWPC_PATHS.speed, signal),
        optional(SWPC_PATHS.field, signal),
      ]);
      signal?.throwIfAborted();
      return {
        ...parseOvation(ovation),
        kp: parseKp(kp),
        scales: parseScales(scales),
        solarWind: parseSolarWind(speed, field),
      };
    },
  };
}
