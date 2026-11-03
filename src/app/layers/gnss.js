import { createGnssIntegrityLayer } from '../../layers/gnss/index.js';

/** Wire the adsb.lol GNSS navigation-integrity layer into the application catalog. */
export function createApplicationGnssIntegrity(options) {
  return createGnssIntegrityLayer(options);
}
