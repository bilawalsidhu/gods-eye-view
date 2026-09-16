import { createLiveTrainsLayer } from '../../layers/trains/index.js';

/** Construct one live-trains layer from a supplied snapshot source. */
export function createApplicationTrains({ source }) {
  return createLiveTrainsLayer({ source });
}
