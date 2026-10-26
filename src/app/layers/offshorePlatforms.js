import { createOffshorePlatformsLayer } from '../../layers/offshorePlatforms/index.js';
import { localGeoJsonServices } from '../localGeojsonServices.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

export function createApplicationOffshorePlatforms(options) {
  return createOffshorePlatformsLayer({
    ...options,
    services: {
      ...localGeoJsonServices,
      overlayHost: {
        ...localGeoJsonServices.overlayHost,
        hitTest: hitTestWorldOverlay,
      },
      isPointerFree,
      openSource: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
      onSelectionChanged(callback) {
        const listener = (event) => callback(event.detail);
        window.addEventListener('gev:entity-selected', listener);
        return () =>
          window.removeEventListener('gev:entity-selected', listener);
      },
    },
  });
}
