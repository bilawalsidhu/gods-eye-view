import * as Cesium from 'cesium';
import { createSubmarineCableLayer } from '../../layers/submarineCables/index.js';
import { createCableSessionLayer } from '../../layers/submarineCables/session.js';
import { rendererFor } from './renderers.js';
import { overlayHost } from './overlayHost.js';
/** Wire cable source geometry to the application overlay host. */
export function createApplicationCables({ session = false, ...options }) {
  const createCesium = (source) =>
    createSubmarineCableLayer({
      overlayHost,
      screenSpaceEventHandlerFactory: (canvas) =>
        new Cesium.ScreenSpaceEventHandler(canvas),
      mapStackEventTarget: typeof window !== 'undefined' ? window : null,
      ...options,
      source,
    });
  if (!session) return createCesium(options.source);
  return createCableSessionLayer({
    source: options.source,
    createCesium,
    createNavara: (engine) =>
      rendererFor('telegeography-submarine-cables', engine, { overlayHost }),
  });
}
