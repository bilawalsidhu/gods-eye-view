import { createTerrainHeights } from '../services/terrainHeights.js';
import { createGroundFloor } from '../services/groundFloor.js';
import { createMeshFloorSampler } from '../services/meshFloorSampler.js';
import { createGroundSnap } from '../services/groundSnap.js';
import { createFireAnchors } from '../layers/firms/anchors.js';

/** Own the DEM, coarse floors and mesh samples used by one application. */
export function createSurfaceServices({
  terrainSource,
  signal,
  eventTarget = globalThis.window,
}) {
  const terrain = createTerrainHeights({ source: terrainSource, signal });
  const groundFloor = createGroundFloor({ terrain, signal });
  const meshFloor = createMeshFloorSampler({
    groundFloor,
    signal,
    eventTarget,
  });
  return Object.freeze({
    terrain,
    groundFloor,
    meshFloor,
    groundSnap: Object.freeze({
      createGroundSnap: () => createGroundSnap({ groundFloor }),
    }),
    anchors: createFireAnchors(groundFloor),
    controlServices: Object.freeze({
      cachedGroundFloor: groundFloor.cachedGroundFloor,
      cachedMeshFloor: groundFloor.cachedMeshFloor,
      GROUND_FLOOR_LIFT_M: groundFloor.GROUND_FLOOR_LIFT_M,
      meshFloorPreferred: groundFloor.meshFloorPreferred,
      warmGroundFloor: groundFloor.warmGroundFloor,
      sampleMeshFloorCells: meshFloor.sampleMeshFloorCells,
    }),
  });
}
