import { createMeshFloorSampler } from '../services/meshFloorSampler.js';
import * as groundFloor from './groundFloor.js';
const meshFloorSampler = createMeshFloorSampler({ groundFloor, eventTarget: typeof window === 'undefined' ? null : window });
export const { sampleMeshFloorCells, cachedGroundFloor } = meshFloorSampler;
