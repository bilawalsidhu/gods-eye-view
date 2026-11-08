import { rendererFor } from './renderers.js';
import { createEarthquakesLayer } from '../../layers/earthquakes/index.js';
import { overlayHost } from './overlayHost.js';
/**
 * Wire earthquake observations to the application overlay host; the discs
 * are the engine's renderer from the manifest (render/display.js on every
 * engine).
 */
export function createApplicationEarthquakes({
  rendererFactory = ({ engine }) => rendererFor('earthquakes', engine),
  ...options
} = {}) {
  return createEarthquakesLayer({ overlayHost, rendererFactory, ...options });
}
