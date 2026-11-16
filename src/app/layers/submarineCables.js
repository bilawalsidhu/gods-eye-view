import { createSubmarineCableLayer } from '../../layers/submarineCables/index.js';
import { overlayHost } from './overlayHost.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import * as picking from '../../data/pickRegistry.js';
/** Wire cable source geometry to the application overlay host. */
export function createApplicationCables(options) {
  return createSubmarineCableLayer({
    // Hit-testing lets a card painted over a cable keep its click.
    overlayHost: { ...overlayHost, hitTest: hitTestWorldOverlay },
    picking,
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    ...options,
  });
}
