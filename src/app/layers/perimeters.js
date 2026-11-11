import { overlayHost } from './overlayHost.js';
import { rendererFor } from './renderers.js';
import {
  createFirePerimetersLayer,
  createInciwebIndexSource,
  createInciwebPublicationSource,
} from '../../layers/perimeters/index.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/**
 * Wire WFIGS fire perimeters into the application catalog; the perimeters
 * are the engine's renderer from the manifest (render/display.js on every
 * engine).
 */
export function createApplicationFirePerimeters(options) {
  return createFirePerimetersLayer({
    overlayHost: overlayHost,
    inciwebSource: createInciwebIndexSource(),
    inciwebPublications: createInciwebPublicationSource(),
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    createRenderer: ({ engine }) => rendererFor('fire-perimeters', engine),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
