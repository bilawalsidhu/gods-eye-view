import { msg } from '../../i18n/marker.js';
import { createIfsFieldSource } from '../weather/ifsFieldSource.js';
import { decodeSeaStateGrid, parseSeaStateManifest } from './model.js';

/** Read the global significant-wave-height field through the same-origin route. */
export function createSeaStateSource({ fetchImpl } = {}) {
  return createIfsFieldSource({
    route: '/api/sea-state',
    errorPrefix: 'Sea state',
    networkError: msg('Sea state network error'),
    malformed: msg('Malformed sea state response'),
    parse: parseSeaStateManifest,
    decode: decodeSeaStateGrid,
    fetchImpl,
  });
}
