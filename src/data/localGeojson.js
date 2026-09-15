import { localGeoJsonServices } from '../app/localGeojsonServices.js';
export { localGeoJsonServices } from '../app/localGeojsonServices.js';
import {
  createLocalGeoJsonLayer as createLayer,
  createLocalInfrastructureOverlayPublisher as createPublisher,
} from './localGeojsonCore.js';

export * from './localGeojsonCore.js';

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
