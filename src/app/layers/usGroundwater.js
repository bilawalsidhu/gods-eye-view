import { createUsGroundwaterLayer } from '../../layers/usGroundwater/index.js';
import * as picking from '../../data/pickRegistry.js';
import { createWellRecordUi } from '../../ui/wellRecordUi.js';

/** Wire the Rainfolk Water Wells layer into the application catalog. */
export function createApplicationUsGroundwater({ source }) {
  return createUsGroundwaterLayer({
    source,
    picking,
    recordUi: createWellRecordUi(),
  });
}
