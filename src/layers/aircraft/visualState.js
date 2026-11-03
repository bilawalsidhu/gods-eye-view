import { createEntityStore } from '../../data/entityRecords.js';

/**
 * What the aircraft layers (flights, military, local ADS-B) remember about the
 * models and billboards they draw, kept beside them rather than on them.
 * - `specKey`: the model spec a model was loaded for; a class change reloads.
 * - `irBoost`: the IR boost a model was loaded with; a flip reloads.
 * - `bellyM`: metres from the model origin to its belly, to sit it on the ground.
 * - `iconLarge`: whether a billboard shows the large icon raster.
 */
export const aircraftVisuals = createEntityStore();
