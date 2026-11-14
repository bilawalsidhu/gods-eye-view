import groundwaterPack from '../../../fixtures/us-groundwater/v1/expected-pack.json' with { type: 'json' };
import { msg } from '../../i18n/marker.js';
import { createSpatialWellSource } from './spatialSource.js';

/** Default sample or generic local static index; no producer runtime required. */
export function createBundledWellPackSource({ pilot = 'sample' } = {}) {
  if (pilot === 'indexed') return createSpatialWellSource();
  if (pilot !== 'sample')
    throw new TypeError('Unknown bundled groundwater source');
  return {
    label: msg('USGS (bounded six-site snapshot)'),
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      return structuredClone(groundwaterPack);
    },
  };
}
