import { defaultSurface } from './surfaceServices.js';
import { firmsServices } from '../app/layers/firms.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import {
  createFirmsHelpers,
  createFirmsSource,
} from '../layers/firms/index.js';
const sourceSlot = createSourceSlot(
  createFirmsSource(),
  ['getSnapshot'],
  'Fire source',
);
export const configureFirmsSource = sourceSlot.configure;
const helpers = createFirmsHelpers({
  services: { ...firmsServices, anchors: defaultSurface.anchors },
});
export const applyFirmsOverlayPolicy = helpers.applyFirmsOverlayPolicy;
