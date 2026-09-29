import {
  createAdsbGnssSource,
  createGnssInterferenceLayer,
} from '../../layers/gnss/index.js';

/** Wire the adsb.lol GNSS interference layer into the application catalog. */
export function createApplicationGnssInterference(options = {}) {
  return createGnssInterferenceLayer({
    source: createAdsbGnssSource(),
    ...options,
  });
}
