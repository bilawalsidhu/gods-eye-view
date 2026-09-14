import { createSourceSlot } from '../app/sourceSlot.js';
import {
  createAlprCamerasLayer,
  createOverpassAlprSource,
} from '../layers/alpr/index.js';
import * as render from '../renderGovernor.js';
import * as context from './contextStore.js';
import * as picking from './pickRegistry.js';
import * as groundFloor from './groundFloor.js';
export * from '../layers/alpr/index.js';
const slot = createSourceSlot(
  createOverpassAlprSource(),
  ['fetch'],
  'ALPR source',
);
export const configureAlprSource = slot.configure;
export default createAlprCamerasLayer({
  source: slot.source,
  services: { render, context, picking, groundFloor },
});
