import { msg } from '../../i18n/marker.js';
import { createGlobalFieldSource } from '../weather/globalFieldSource.js';
import {
  decodeOceanCurrentsGrid,
  parseOceanCurrentsManifest,
} from './model.js';

/** Read the global surface-current field through the same-origin route. */
export function createOceanCurrentsSource({ fetchImpl } = {}) {
  const source = createGlobalFieldSource({
    route: '/api/ocean-currents',
    errorPrefix: 'Ocean currents',
    networkError: msg('Ocean currents network error'),
    malformed: msg('Malformed ocean currents response'),
    parse: parseOceanCurrentsManifest,
    decode: decodeOceanCurrentsGrid,
    components: 2,
    fetchImpl,
  });
  return {
    async getSnapshot(options) {
      const { values, ...manifest } = await source.getSnapshot(options);
      return { ...manifest, u: values.u, v: values.v };
    },
  };
}
