import { defaultSurface } from './surfaceServices.js';
import { createApplicationFirms, firmsServices } from '../app/layers/firms.js';
import { createSourceSlot } from '../app/sourceSlot.js';
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
export const mapAnalystRecord = helpers.mapAnalystRecord;
export const fireCullPosition = helpers.fireCullPosition;
export const applyHorizonCull = helpers.applyHorizonCull;
export const buildSelectedFireCard = helpers.buildSelectedFireCard;
export const buildFireCard = helpers.buildFireCard;
export const buildCellCard = helpers.buildCellCard;
export const applyFirmsOverlayPolicy = helpers.applyFirmsOverlayPolicy;

/** Retain the existing default feed and helper exports for direct callers. */
export function createFirmsHeatmapLayer(options) {
  return createApplicationFirms({
    surface: defaultSurface,
    ...options,
    feed: options.feed ?? sourceSlot.source,
  });
}
