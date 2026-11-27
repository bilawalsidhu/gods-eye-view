import { createApplicationBikeshare } from '../app/layers/bikeshare.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';

const sourceSlot = createSourceSlot(
  createBikeshareSource(),
  ['getStations'],
  'Bikeshare source',
);
export const configureBikeshareSource = sourceSlot.configure;
const layer = createApplicationBikeshare({
  source: sourceSlot.source,
});
export const createBikeshareSelectedOverlayEntry =
  layer.createBikeshareSelectedOverlayEntry;
export {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
} from '../layers/bikeshare/index.js';
