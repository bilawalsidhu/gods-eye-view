import { createGnssIntegrityLayer } from '../../layers/gnss/index.js';
import { worldTimeFor } from '../../time/worldClock.js';

/** Wire the adsb.lol GNSS navigation-integrity layer into the application catalog. */
export function createApplicationGnssIntegrity(options) {
  return createGnssIntegrityLayer({
    worldNow: worldTimeFor('gnss-integrity'),
    ...options,
  });
}
