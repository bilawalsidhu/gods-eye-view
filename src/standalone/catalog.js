import { createSurfaceServices } from '../app/surfaceServices.js';
import { createApplicationRequestServices } from '../services/requests.js';
import { endpointSet, storedApiBase } from '../mobile/runtimeConfig.js';
import { shouldUseDirect } from '../mobile/sourcePolicy.js';
import { createTerrainDirectSource } from '../mobile/adapters/tileFeedsDirect.js';
import { createApplicationCatalog } from '../app/constructCatalog.js';
import { createStandaloneLayerSources } from './layerSources.js';
export { createStandaloneReferenceSources } from './layerSources.js';

/** Create fresh layer instances using the existing standalone source choices. */
export function createStandaloneCatalog({
  nepalBoundaryResolver,
  sources = {},
  streetLevelProviders,
  signal = new AbortController().signal,
  surface,
  fetchImpl,
  getKey,
  direct,
} = {}) {
  const useDirect = direct ?? shouldUseDirect();
  if (surface === undefined) {
    surface = createSurfaceServices({
      terrainSource: useDirect
        ? createTerrainDirectSource(fetchImpl ? { fetchImpl } : {})
        : createApplicationRequestServices({
            endpoints: endpointSet(storedApiBase()),
          }).terrain,
      signal,
    });
  }
  return createApplicationCatalog({
    nepalBoundaryResolver,
    surface,
    sources: createStandaloneLayerSources(sources, {
      fetchImpl,
      getKey,
      direct: useDirect,
    }),
    streetLevelProviders,
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
