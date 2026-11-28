import {
  createFirePerimetersLayer,
  createInciwebIndexSource,
  createInciwebPublicationSource,
} from '../../layers/perimeters/index.js';
import * as picking from '../../data/pickRegistry.js';
import { openExternal, overlayHost } from './overlayHost.js';

/** Wire fire perimeters into the application catalog. */
export function createApplicationFirePerimeters({
  inciweb = true,
  ...options
} = {}) {
  return createFirePerimetersLayer({
    overlayHost,
    ...(inciweb !== false && {
      inciwebSource: createInciwebIndexSource(),
      inciwebPublications: createInciwebPublicationSource(),
    }),
    openExternal,
    picking,
    ...options,
    // inciweb: false outranks InciWeb sources in options.
    ...(inciweb === false && {
      inciwebSource: null,
      inciwebPublications: null,
    }),
  });
}
