import { rendererFor } from './renderers.js';
import { createGnssIntegrityLayer } from '../../layers/gnss/index.js';
import { worldTimeFor } from '../../time/worldClock.js';

/**
 * Wire the adsb.lol GNSS navigation-integrity layer into the application
 * catalog; the cells are the engine's renderer from the manifest
 * (render/display.js on every engine).
 */
export function createApplicationGnssIntegrity(options) {
  return createGnssIntegrityLayer({
    rendererFactory: ({ engine }) => rendererFor('gnss-integrity', engine),
    worldNow: worldTimeFor('gnss-integrity'),
    ...options,
  });
}
