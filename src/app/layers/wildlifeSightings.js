import { overlayHost } from './overlayHost.js';
import { createWildlifeSightingsLayer } from '../../layers/wildlifeSightings/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as focus from '../../worldFocus.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Bind the wildlife layer to the application's selection and overlay owners. */
export function createApplicationWildlifeSightings(options) {
  return createWildlifeSightingsLayer({
    overlayHost: overlayHost,
    picking,
    pointer: { isPointerFree },
    render,
    context,
    focus,
    ...options,
  });
}
