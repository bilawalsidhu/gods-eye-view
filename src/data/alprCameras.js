import { defaultSurface } from './surfaceServices.js';
import { createApplicationAlpr } from '../app/layers/alprCameras.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createOverpassAlprSource } from '../layers/alpr/index.js';
export * from '../layers/alpr/index.js';
const slot = createSourceSlot(
  createOverpassAlprSource(),
  ['fetch'],
  'ALPR source',
  { destroy: () => {} },
);
export const configureAlprSource = slot.configure;
export default createApplicationAlpr({
  surface: defaultSurface,
  source: slot.source,
});
