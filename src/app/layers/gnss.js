import { createGnssInterferenceLayer } from '../../layers/gnss/index.js';

/** Wire the adsb.lol GNSS interference layer into the application catalog. */
export function createApplicationGnssInterference(options) {
  return createGnssInterferenceLayer(options);
}
