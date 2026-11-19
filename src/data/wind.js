import { createSourceSlot } from '../sources/sourceSlot.js';
import { createWindSource } from '../layers/wind/source.js';

const sourceSlot = createSourceSlot(
  createWindSource(),
  ['getSnapshot'],
  'Wind source',
);
export const configureWindSource = sourceSlot.configure;
