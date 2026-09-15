import { createSurfaceServices } from '../app/surfaceServices.js';
import { createApplicationRequestServices } from '../services/requests.js';
import { createApplicationCatalog } from '../app/constructCatalog.js';
import { createStandaloneLayerSources } from './layerSources.js';
export { createStandaloneReferenceSources } from './layerSources.js';

/** Create fresh layer instances using the existing standalone source choices. */
export function createStandaloneCatalog({
  signal = new AbortController().signal,
  surface = createSurfaceServices({
    terrainSource: createApplicationRequestServices().terrain,
    signal,
  }),
} = {}) {
  return createApplicationCatalog({
    surface,
    sources: createStandaloneLayerSources(),
    signal,
    vesselOptions: {
      maxRows: import.meta.env?.VITE_AIS_LIVE_MAX_ROWS,
      maxLabels: import.meta.env?.VITE_AIS_LIVE_LABEL_MAX_ROWS,
    },
  });
}

// Direct compatibility callers share one catalog; application startup supplies its own.
let compatibilityCatalog;
export function getStandaloneCatalog() {
  return (compatibilityCatalog ||= createStandaloneCatalog());
}
