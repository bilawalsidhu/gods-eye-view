import { msg } from '../../i18n/marker.js';
import { createIfsFieldSource } from '../weather/ifsFieldSource.js';
import {
  decodeOceanCurrentsGrid,
  parseOceanCurrentsManifest,
} from './model.js';

/** Read the global surface-current field through the same-origin route. */
export function createOceanCurrentsSource({ fetchImpl } = {}) {
  const source = createIfsFieldSource({
    route: '/api/ocean-currents',
    errorPrefix: 'Ocean currents',
    networkError: msg('Ocean currents network error'),
    malformed: msg('Malformed ocean currents response'),
    parse: parseOceanCurrentsManifest,
    decode: decodeOceanCurrentsGrid,
    fetchImpl,
  });
  return {
    async getSnapshot(options) {
      const { values, ...manifest } = await source.getSnapshot(options);
      return { ...manifest, u: values.u, v: values.v };
    },
  };
}
