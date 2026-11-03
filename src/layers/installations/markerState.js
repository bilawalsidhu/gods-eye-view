import { createEntityStore } from '../../data/entityRecords.js';

/**
 * What the installations layer last drew for a retained marker entity, so an
 * unchanged record leaves it alone: `heightM` (surface height) and `selected`.
 */
export const installationMarkers = createEntityStore();
