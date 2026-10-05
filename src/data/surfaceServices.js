import * as terrain from './terrainHeights.js';
import * as groundFloor from './groundFloor.js';
import * as meshFloor from './meshFloorSampler.js';
import * as groundSnap from './groundSnap.js';
import * as anchors from './fireAnchors.js';
/** Default scene services for direct data-module compatibility callers. */
export const defaultSurface = Object.freeze({
  terrain,
  groundFloor,
  meshFloor,
  groundSnap,
  anchors,
});
