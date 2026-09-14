import { createSourceSlot } from '../app/sourceSlot.js';
import { createPrecipitationLayer } from '../layers/precipitation/index.js';
import { createPrecipitationSource } from '../layers/precipitation/source.js';

const sourceSlot = createSourceSlot(
  createPrecipitationSource(),
  ['getFrame'],
  'Precipitation source',
);
/** Wire the standalone frame source and application layer owner. */
export const configurePrecipitationSource = sourceSlot.configure;
const layer = createPrecipitationLayer({ source: sourceSlot.source });
export default layer;
