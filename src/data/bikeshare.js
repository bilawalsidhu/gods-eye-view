import { createSourceSlot } from '../app/sourceSlot.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createBikeshareLayer } from '../layers/bikeshare/index.js';
import * as render from '../renderGovernor.js';
import * as sprites from './spriteOrder.js';
import * as picking from './pickRegistry.js';
import * as overlays from '../overlays/worldOverlay.js';

const sourceSlot = createSourceSlot(
  createBikeshareSource(),
  ['getStations'],
  'Bikeshare source',
);
export const configureBikeshareSource = sourceSlot.configure;
const layer = createBikeshareLayer({
  source: sourceSlot.source,
  services: { render, sprites, picking, overlays },
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
