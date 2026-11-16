import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/**
 * What an entity-card layer needs from the app: the shared pick registry and
 * the pointer-ownership check. Passed in, so the layers never import the app.
 */
export const entityInteraction = Object.freeze({
  registerPickOwner,
  unregisterPickOwner,
  isPointerFree,
});
