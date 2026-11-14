/**
 * The place packs in the top-centre loading status: they load lazily, on the
 * Cockpit's first place lookup (`src/data/placeBelow.js`), so while one is on
 * its way the status names them beside the layers, and a pack that would not
 * load makes the batch end LOAD FAILED.
 */

import { placePacksStatus } from '../data/placeBelow.js';
import { LOADING_NAME_KEYS } from './layerNames.js';

/**
 * The data layers, with the place packs as one more entry while they load
 * or after one would not load, so a batch they join ends LOAD FAILED rather
 * than LOAD COMPLETE.
 */
export function withPlacePacks(
  layers,
  { loading, failed } = placePacksStatus(),
) {
  if (!loading && !failed) return layers;
  return [
    ...layers,
    {
      id: 'place-names',
      name: LOADING_NAME_KEYS['place-names'],
      enabled: true,
      stats: { loading, error: failed ? 'Place names did not load' : null },
    },
  ];
}
