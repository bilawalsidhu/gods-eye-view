import { createSubmarineCableLayer } from '../../layers/submarineCables/index.js';
import { CABLE_OVERLAY_SOURCE_ID } from '../../layers/submarineCables/policy.js';
import { rendererFor } from './renderers.js';
import { overlayHost as applicationOverlayHost } from './overlayHost.js';

/**
 * Wire cable source geometry to the application overlay host and map-stack
 * events; it draws with the engine's renderer from the manifest
 * (render/display.js on every engine).
 */
export function createApplicationCables({
  source,
  overlayHost = applicationOverlayHost,
  mapStackEventTarget = typeof window !== 'undefined' ? window : null,
  sweepClock,
  createDisplay = (engine) =>
    rendererFor(CABLE_OVERLAY_SOURCE_ID, engine, {
      overlayHost,
      mapStackEventTarget,
      ...(sweepClock ? { sweepClock } : {}),
    }),
}) {
  return createSubmarineCableLayer({ source, createDisplay });
}
