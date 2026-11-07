import { msg } from '../../i18n/marker.js';
import { createGlobalFieldSource } from '../weather/globalFieldSource.js';
import {
  decodeSeaSurfaceTemperatureGrid,
  parseSeaSurfaceTemperatureManifest,
} from './model.js';

/**
 * Read the global sea surface temperature field, or its anomaly, through the
 * same-origin routes. `getSnapshot({view})` picks the route; the snapshot
 * names its view.
 */
export function createSeaSurfaceTemperatureSource({ fetchImpl } = {}) {
  const views = {
    temperature: createGlobalFieldSource({
      route: '/api/sea-surface-temperature',
      errorPrefix: 'Sea surface temperature',
      networkError: msg('Sea surface temperature network error'),
      malformed: msg('Malformed sea surface temperature response'),
      parse: (payload) =>
        parseSeaSurfaceTemperatureManifest(payload, 'temperature'),
      decode: decodeSeaSurfaceTemperatureGrid,
      fetchImpl,
    }),
    anomaly: createGlobalFieldSource({
      route: '/api/sea-surface-temperature-anomaly',
      // Marked so the HTTP error shape can translate the source name.
      errorPrefix: msg('Sea surface temperature anomaly'),
      networkError: msg('Sea surface temperature anomaly network error'),
      malformed: msg('Malformed sea surface temperature anomaly response'),
      parse: (payload) =>
        parseSeaSurfaceTemperatureManifest(payload, 'anomaly'),
      decode: decodeSeaSurfaceTemperatureGrid,
      fetchImpl,
    }),
  };
  return {
    getSnapshot({ signal, view = 'temperature' } = {}) {
      const source = views[view];
      if (!source)
        return Promise.reject(
          new TypeError(`Unknown sea surface temperature view: ${view}`),
        );
      return source.getSnapshot({ signal });
    },
  };
}
