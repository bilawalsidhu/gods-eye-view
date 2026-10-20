import { msg } from '../../i18n/marker.js';
import { createEcccAirQualitySource } from './source.js';
import { selectSaReadings } from './southAfrica.js';
import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Portable provider composition: no acquisition until getSnapshot is called. */
export function createAirQualitySource({
  canada = createEcccAirQualitySource(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  let coverage = null;
  return {
    providers: Object.freeze(['eccc', 'saaqis']),
    getCoverage: () => coverage,
    async getSnapshot({ provider = 'eccc', parameter = 'PM2.5', signal } = {}) {
      if (provider === 'eccc') {
        coverage = null;
        return canada.getSnapshot({ signal });
      }
      if (provider !== 'saaqis')
        throw new Error(msg('Unknown air quality provider'));
      const requestSignal = AbortSignal.any([
        AbortSignal.timeout(50_000),
        ...(signal ? [signal] : []),
      ]);
      const response = await fetchImpl('/api/air-quality/south-africa', {
        signal: requestSignal,
      });
      if (!response.ok)
        throw new Error(msg('South African air quality unavailable'));
      const payload = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
        requestSignal,
      );
      if (payload?.schemaVersion !== 1 || !Array.isArray(payload.stations))
        throw new Error(msg('Malformed South African air quality snapshot'));
      signal?.throwIfAborted();
      const readings = selectSaReadings(payload, parameter, now());
      coverage = {
        stations: payload.stations,
        stale: payload.stale === true,
        fetchedAt: payload.fetchedAt,
      };
      return readings;
    },
  };
}
