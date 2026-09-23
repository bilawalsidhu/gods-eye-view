import { createState } from './state.js';
import { createPresentation } from './presentation.js';
import { createInteraction } from './interaction.js';
import { createRendering } from './rendering.js';
import { createQueries } from './queries.js';
import { createIngestion } from './ingestion.js';
import { createLifecycle } from './lifecycle.js';
import { createControls } from './controls.js';

/**
 * Construct one Web Receivers layer with its own scene state and supplied
 * application services.
 *
 * Internet-controllable receivers (KiwiSDR, WebSDR, OpenWebRX) become globe
 * markers you can find and tune. The directory comes from the supplied
 * source; tuning is a URL the panel or a new tab opens, so the receiver sees
 * the listener's own browser and GEV never proxies audio or control.
 *
 * @param {{services: object, source: object}} options
 * @returns {object} The data-layer module the manager registers.
 */
export function createWebReceiversLayer({ services, source }) {
  if (!services?.picking || !services?.render || !services?.ground) {
    throw new TypeError(
      'A web receivers layer needs picking, render and ground services',
    );
  }
  if (typeof source?.getCatalog !== 'function') {
    throw new TypeError('A web receivers source needs a catalog operation');
  }
  const state = createState();
  const parts = {};
  const context = { state, services, parts, source };
  parts.presentation = createPresentation(context);
  parts.interaction = createInteraction(context);
  parts.rendering = createRendering(context);
  parts.queries = createQueries(context);
  parts.ingestion = createIngestion(context);
  parts.lifecycle = createLifecycle(context);
  parts.controls = createControls(context);
  return Object.assign(
    {},
    parts.lifecycle.methods,
    parts.ingestion.methods,
    parts.controls.methods,
  );
}

export { createWebReceiversSource } from './source.js';
export { isValidWebReceiver, freezeWebReceiver } from './model.js';
export {
  WEB_RECEIVERS_LAYER_ID,
  RECEIVER_TYPE_COLORS,
  CATALOG_ENDPOINT,
} from './policy.js';
