import { createEntityStore } from '../../data/entityRecords.js';

/**
 * The camera a picked coverage ray or projection plane belongs to: `cameraId`
 * is the upstream camera id. Gizmo entities never get one.
 */
export const cctvPicks = createEntityStore();
