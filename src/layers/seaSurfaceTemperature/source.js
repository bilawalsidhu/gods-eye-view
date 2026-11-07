import { msg } from '../../i18n/marker.js';
import { createGlobalFieldSource } from '../weather/globalFieldSource.js';
import {
  decodeSeaSurfaceTemperatureGrid,
  parseSeaSurfaceTemperatureManifest,
} from './model.js';

/** Read the global sea surface temperature field through the same-origin route. */
export function createSeaSurfaceTemperatureSource({ fetchImpl } = {}) {
  return createGlobalFieldSource({
    route: '/api/sea-surface-temperature',
    errorPrefix: 'Sea surface temperature',
    networkError: msg('Sea surface temperature network error'),
    malformed: msg('Malformed sea surface temperature response'),
    parse: parseSeaSurfaceTemperatureManifest,
    decode: decodeSeaSurfaceTemperatureGrid,
    fetchImpl,
  });
}
