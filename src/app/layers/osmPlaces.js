import { createOsmPlacesLayer } from '../../layers/osmPlaces/index.js';
import { overlayHost } from './overlayHost.js';
import { rendererFor } from './renderers.js';

/**
 * Wire OSM Places labels to the application overlay host; the points are the
 * engine's renderer from the manifest (render/display.js on every engine).
 */
export function createApplicationOsmPlaces() {
  return createOsmPlacesLayer({
    overlayHost,
    createRenderer: ({ engine }) => rendererFor('osm-places', engine),
  });
}
