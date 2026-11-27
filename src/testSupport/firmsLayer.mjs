/** The FIRMS layer and its helpers on the default surface, for FIRMS tests. */
import { defaultSurface } from '../data/surfaceServices.js';
import { createApplicationFirms, firmsServices } from '../app/layers/firms.js';
import {
  createFirmsHelpers,
  createFirmsSource,
} from '../layers/firms/index.js';

export const firmsHelpers = createFirmsHelpers({
  services: { ...firmsServices, anchors: defaultSurface.anchors },
});
export const {
  mapAnalystRecord,
  fireCullPosition,
  buildSelectedFireCard,
  buildFireCard,
  buildCellCard,
} = firmsHelpers;

export function createFirmsHeatmapLayer(options) {
  return createApplicationFirms({
    surface: defaultSurface,
    ...options,
    feed: options.feed ?? createFirmsSource(),
  });
}
