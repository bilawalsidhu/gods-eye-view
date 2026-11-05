import { rendererFor } from './renderers.js';
import { createAwarenessLayer } from '../../layers/awareness/index.js';
import * as navigation from '../../navigationPolicy.js';
import * as geometry from '../../celestialRing.js';
import * as render from '../../renderGovernor.js';
/** Bind Contacts to the same catalog instances used for rendering. */
export function createApplicationAwareness({
  flights,
  military,
  vessels,
  installations,
}) {
  return createAwarenessLayer({
    services: {
      flights,
      military,
      vessels,
      installations,
      navigation,
      geometry,
      renderer: (engine) => rendererFor('military-awareness', engine),
      render,
    },
  });
}
