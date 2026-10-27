import { rendererFor } from './renderers.js';
import { createEarthquakesCesiumRenderer } from '../../layers/earthquakes/render/cesium.js';
import { createEarthquakesLayer } from '../../layers/earthquakes/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire earthquake observations to the application overlay host. */
export function createApplicationEarthquakes({
  renderer = {
    create: ({ engine = null, ...options }) =>
      engine
        ? rendererFor('earthquakes', engine, options)
        : createEarthquakesCesiumRenderer(null, options),
  },
  ...options
} = {}) {
  return createEarthquakesLayer({ overlayHost, renderer, ...options });
}
