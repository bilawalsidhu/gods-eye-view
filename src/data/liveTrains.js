import { createApplicationTrains } from '../app/layers/liveTrains.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createAmtrakerTrainSource } from '../layers/trains/index.js';
export * from '../layers/trains/index.js';
const slot = createSourceSlot(
  createAmtrakerTrainSource(),
  ['getSnapshot'],
  'Train source',
);
export const configureTrainSource = slot.configure;
export default createApplicationTrains({ source: slot.source });
