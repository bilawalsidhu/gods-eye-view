import { createCyclonesLayer } from '../../layers/cyclones/index.js';
import * as context from '../../data/contextStore.js';
import { rendererFor } from './renderers.js';

/**
 * Wire cyclone selection to the application shared context; the layer draws
 * with the engine's renderer from the manifest (render/display.js on every
 * engine). The catalog passes the same factory as `createNativeRendering`.
 */
export function createApplicationCyclones({
  createNativeRendering,
  createRendering = createNativeRendering ??
    ((engine, options) => rendererFor('weather-cyclones', engine, options)),
  ...options
} = {}) {
  return createCyclonesLayer({
    context: typeof window !== 'undefined' ? context : null,
    createRendering,
    ...options,
  });
}
