import { createApplicationSatellites } from '../app/layers/satellites.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createSatelliteSource } from '../layers/satellites/index.js';

const sourceSlot = createSourceSlot(
  createSatelliteSource(),
  ['readGroup'],
  'Satellite source',
);
export const configureSatelliteSource = sourceSlot.configure;
const layer = createApplicationSatellites({
  source: sourceSlot.source,
});
export const createIssOverlayEntry = layer.createIssOverlayEntry;
export const findSatelliteOrbitTrackInTle = layer.findSatelliteOrbitTrackInTle;
export const getSatelliteOrbitTrack = layer.getSatelliteOrbitTrack;
export {
  ISS_OVERLAY_SOURCE_ID,
  ISS_OVERLAY_SOURCE_OPTIONS,
} from '../layers/satellites/index.js';
export default layer;
