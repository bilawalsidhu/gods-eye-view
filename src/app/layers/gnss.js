import { rendererFor } from './renderers.js';
import { createGnssCesiumRenderer } from '../../layers/gnss/render/cesium.js';
import { createGnssIntegrityLayer } from '../../layers/gnss/index.js';

/** Wire the adsb.lol GNSS navigation-integrity layer into the application catalog. */
export function createApplicationGnssIntegrity(options) {
  return createGnssIntegrityLayer({
    createRenderer: ({ viewer, engine, viewAnchor }) =>
      engine
        ? rendererFor('gnss-integrity', engine, { viewer, viewAnchor })
        : createGnssCesiumRenderer({ viewer, viewAnchor }),
    ...options,
  });
}
