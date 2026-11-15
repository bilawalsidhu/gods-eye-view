import { createUsGroundwaterLayer } from '../../layers/usGroundwater/index.js';
import * as picking from '../../data/pickRegistry.js';
import { formatNumber } from '../../i18n/index.js';
import { createWellRecordUi } from '../../ui/wellRecordUi.js';

/** Wire the Rainfolk Water Wells layer into the application catalog. */
export function createApplicationUsGroundwater({ source }) {
  return createUsGroundwaterLayer({
    source,
    picking,
    recordUi: createWellRecordUi(),
    // Millions of records: "12.5M" rather than the panel's "12452.3K".
    formatCount: (n) =>
      formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 }),
  });
}
