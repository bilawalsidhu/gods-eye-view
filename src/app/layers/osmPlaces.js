import { createOsmPlacesLayer } from '../../layers/osmPlaces/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire OSM Places labels to the application overlay host. */
export function createApplicationOsmPlaces() {
  return createOsmPlacesLayer({ overlayHost });
}
