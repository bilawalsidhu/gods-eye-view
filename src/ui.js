import { StyleManager as ApplicationControls } from './ui/composition.js';
import { catalogControlServices } from './app/catalog.js';
import { getStandaloneCatalog } from './standalone/catalog.js';
/** Compatibility entry for direct standalone control construction. */
export class StyleManager extends ApplicationControls {
  constructor(viewer, options = {}) {
    super(viewer, {
      ...options,
      services: {
        ...catalogControlServices(getStandaloneCatalog()),
        ...getStandaloneCatalog().surface.controlServices,
        ...options.services,
      },
    });
  }
}
