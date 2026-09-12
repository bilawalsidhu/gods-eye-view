import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  createLocalGeoJsonLayer as createLayer,
  createLocalInfrastructureOverlayPublisher as createPublisher,
} from './localGeojsonCore.js';

export * from './localGeojsonCore.js';

/** Existing standalone application operations, shared by its local layers. */
export const localGeoJsonServices = Object.freeze({
  overlayHost: Object.freeze({
    clearSource: clearOverlaySource,
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
  }),
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
  governorRequestRender,
});

/** Create a layer using the standalone app's operations; retain overlay overrides. */
export function createLocalGeoJsonLayer(options) {
  return createLayer(options, {
    ...localGeoJsonServices,
    overlayHost: options.overlayHost === undefined
      ? localGeoJsonServices.overlayHost : options.overlayHost,
  });
}

/** Create an overlay publisher using the standalone app's host by default. */
export function createLocalInfrastructureOverlayPublisher(options) {
  return createPublisher({
    ...options,
    host: options.host === undefined ? localGeoJsonServices.overlayHost : options.host,
  });
}
