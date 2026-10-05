import { createGroundSnap as createSnap } from '../services/groundSnap.js';
import * as groundFloor from './groundFloor.js';
/** Compatibility constructor using the default floor cache. */
export function createGroundSnap() {
  return createSnap({ groundFloor });
}
