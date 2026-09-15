import { createApplicationBikeshare } from '../app/layers/bikeshare.js';
import { createSourceSlot } from '../app/sourceSlot.js';
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
export const _setBikeshareSelectionStateForTest =
  layer._setBikeshareSelectionStateForTest;
export const _selectBikeshareStationForTest =
  layer._selectBikeshareStationForTest;
export const _clearBikeshareSelectionForTest =
  layer._clearBikeshareSelectionForTest;
export {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
} from '../layers/bikeshare/index.js';
export default layer;
