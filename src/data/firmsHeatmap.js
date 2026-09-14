import { createSourceSlot } from '../app/sourceSlot.js';
import * as Cesium from 'cesium';
import {
  createFirmsHeatmapLayer as createLayer,
  createFirmsHelpers,
  createFirmsSource,
} from '../layers/firms/index.js';
import * as render from '../renderGovernor.js';
import * as sprites from './spriteOrder.js';
import * as context from './contextStore.js';
import * as picking from './pickRegistry.js';
import * as anchors from './fireAnchors.js';
import * as overlays from '../overlays/worldOverlay.js';
import * as focus from '../worldFocus.js';
const services = {
  render,
  sprites,
  context,
  picking,
  anchors,
  overlays,
  focus,
};
const sourceSlot = createSourceSlot(
  createFirmsSource(),
  ['getSnapshot'],
  'Fire source',
);
export const configureFirmsSource = sourceSlot.configure;
const helpers = createFirmsHelpers({ services });
export const mapAnalystRecord = helpers.mapAnalystRecord;
export const fireCullPosition = helpers.fireCullPosition;
export const applyHorizonCull = helpers.applyHorizonCull;
export const buildSelectedFireCard = helpers.buildSelectedFireCard;
export const buildFireCard = helpers.buildFireCard;
export const buildCellCard = helpers.buildCellCard;
export const applyFirmsOverlayPolicy = helpers.applyFirmsOverlayPolicy;

/** Supply the local source and the application's scene service owners. */
export function createFirmsHeatmapLayer(options) {
  return createLayer({
    ...options,
    icon: options.icon ?? '▲',
    source: options.source ?? 'NASA FIRMS',
    feed: options.feed ?? sourceSlot.source,
    services,
    overlayHost: options.overlayHost ?? {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    screenSpaceEventHandlerFactory:
      options.screenSpaceEventHandlerFactory ??
      ((viewer) => new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)),
  });
}
