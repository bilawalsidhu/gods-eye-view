import { MAP_STACKS } from './catalog.js';
import { photorealUnavailableReason } from './availability.js';
import { keySetupRequirement } from '../keySetupCore.mjs';
import { imageryFactoryFor, ESRI_ATTRIBUTION_HTML } from './imagery.js';
import { terrainSourceFor } from './terrain.js';

/** Select sources and setup guidance without putting provider branches in the controller. */
export function createDefaultMapSources({
  googleTileset = null,
  cesiumToken = '',
  googleApiKey = '',
} = {}) {
  const ionToken = String(cesiumToken || '').trim();
  const hasIon = Boolean(ionToken);
  // Engine-neutral descriptions ride beside the Cesium factories: a terrain
  // `kind` (+ token), ion imagery's token and the photoreal credentials, so
  // an engine that builds its own sources needs none of the factories.
  const terrain = {
    ...terrainSourceFor(ionToken),
    kind: hasIon ? 'world' : 'keyless',
    ...(hasIon && { accessToken: ionToken }),
  };
  const googleKey = String(googleApiKey || '').trim();
  const hasGoogle = Boolean(googleKey);
  return {
    defaultId: googleTileset ? 'photoreal' : 'esri-imagery',
    unknownId: 'photoreal',
    recoveryId: googleTileset ? 'photoreal' : null,
    state: { hasCesiumIonToken: hasIon },
    sources: MAP_STACKS.map((descriptor) => {
      const common = {
        descriptor,
        available: !descriptor.requiresIon || hasIon,
        unavailableReason: descriptor.requiresIon
          ? keySetupRequirement('cesium-ion')
          : null,
      };
      if (descriptor.kind === 'photoreal')
        return {
          ...common,
          available: Boolean(googleTileset),
          unavailableReason: photorealUnavailableReason(hasIon || hasGoogle),
          tileset: googleTileset,
          ...(googleKey && { googleApiKey: googleKey }),
          ...(hasIon && { cesiumToken: ionToken }),
        };
      const imagery = imageryFactoryFor(descriptor, ionToken);
      return {
        ...common,
        imagery,
        ...(descriptor.kind === 'ion' && { accessToken: ionToken }),
        terrain,
        ...(descriptor.id === 'esri-imagery'
          ? {
              credit: ESRI_ATTRIBUTION_HTML,
              constructionFallback: {
                id: 'osm',
                message: 'Esri Satellite is unavailable; using OSM',
              },
              tileFailureFallback: {
                id: 'osm',
                threshold: 2,
                message: 'Esri Satellite tile requests failed; using OSM',
              },
            }
          : {}),
      };
    }),
  };
}
