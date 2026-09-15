import { createGroundFloor } from '../services/groundFloor.js';
import * as terrain from './terrainHeights.js';
const groundFloor = createGroundFloor({ terrain });
export const { GROUND_FLOOR_LIFT_M, MESH_FLOOR_BELOW_PRIOR_M, MESH_FLOOR_ABOVE_PRIOR_M, coarseFloorCoord, floorAltitudeM, displayFloorHeightM, FLOOR_CELL_DEG, NEIGHBOR_FLOOR_MIN_SAMPLES, neighborFloorM, CORRIDOR_MAX_CELLS, CORRIDOR_WALK_STEP_DEG, CELL_HYSTERESIS_DEG, stickyFloorCell, corridorFloorCells, allocateCorridorCells, setMeshFloorPreferred, meshFloorPreferred, reportMeshFloorCell, meshFloorSampleWithinPrior, reportValidatedMeshFloorCell, cachedMeshFloor, _clearMeshFloorCellsForTest, cachedGroundFloor, FLOOR_RESOLVE_DEADLINE_MS, resolveGroundFloorCellsBounded, resolveGroundFloorCells, warmGroundFloor } = groundFloor;
