import {
  createOsmPlacesLayer,
  createOsmPlacesCesiumRenderer,
} from '../../layers/osmPlaces/index.js';
import { overlayHost } from './overlayHost.js';
import { rendererFor } from './renderers.js';

/** Wire OSM Places labels to the application overlay host. */
export function createApplicationOsmPlaces() {
  return createOsmPlacesLayer({
    overlayHost,
    createRenderer: ({ viewer, engine }) =>
      engine
        ? rendererFor('osm-places', engine, { viewer })
        : createOsmPlacesCesiumRenderer({ viewer }),
  });
}
