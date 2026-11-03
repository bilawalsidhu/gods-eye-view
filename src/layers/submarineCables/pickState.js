import { createEntityStore } from '../../data/entityRecords.js';

/**
 * The reference a picked cable, landing point or reference marker flies to:
 * `info` is `{ label, kind, featureId, reference: { lon, lat } }`.
 */
export const cablePicks = createEntityStore();
