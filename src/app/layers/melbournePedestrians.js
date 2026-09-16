import { createPedestriansLayer } from '../../layers/pedestrians/index.js';

/** Construct one Melbourne pedestrian-counter layer from a supplied source. */
export function createApplicationPedestrians({ source }) {
  return createPedestriansLayer({ source });
}
