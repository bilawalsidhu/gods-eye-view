import { createGdacsAlertsLayer } from '../../layers/gdacs/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as context from '../../data/contextStore.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/** Wire the GDACS disaster alerts layer into the application catalog. */
export function createApplicationGdacsAlerts(options) {
  return createGdacsAlertsLayer({
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    pointer: { isPointerFree },
    overlayHost,
    context,
    ...options,
  });
}
