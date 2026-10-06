import { MAP_STACKS } from './catalog.js';
import { photorealUnavailableReason } from './availability.js';
import { keySetupRequirement } from '../keySetupCore.mjs';
import {
  createOsmImagery,
  createEsriImagery,
  createIonImagery,
  createSentinel2Imagery,
  ESRI_ATTRIBUTION_HTML,
  SENTINEL2_LAYER_OPTIONS,
} from './imagery.js';
import { sentinel2AttributionHtml } from '../data/sentinel2Tiles.js';
import { createWorldTerrain, createKeylessTerrain } from './terrain.js';

/**
 * Select sources and setup guidance without putting provider branches in the
 * controller. `sentinelHubConfigured` comes from the server's
 * /api/sentinel2/status (the credentials themselves never reach the browser);
 * without it Sentinel-2 Latest is listed but locked, and nothing else changes.
 */
export function createDefaultMapSources({
  googleTileset = null,
  cesiumToken = '',
  googleApiKey = '',
  sentinelHubConfigured = false,
} = {}) {
  const ionToken = String(cesiumToken || '').trim();
  const hasIon = Boolean(ionToken);
  const hasGoogle = Boolean(String(googleApiKey || '').trim());
  const terrain = {
    id: hasIon ? 'world' : 'keyless',
    create: hasIon
      ? (request) => createWorldTerrain(ionToken, request)
      : createKeylessTerrain,
  };
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
        };
      if (descriptor.kind === 'sentinel2')
        return {
          ...common,
          available: sentinelHubConfigured === true,
          unavailableReason: keySetupRequirement('sentinel-hub'),
          imagery: createSentinel2Imagery,
          layerOptions: SENTINEL2_LAYER_OPTIONS,
          underlay: { id: 'esri-imagery' },
          terrain,
          credit: sentinel2AttributionHtml(),
          tileFailureFallback: {
            id: 'esri-imagery',
            threshold: 3,
            message:
              'Sentinel-2 tiles unavailable (daily free quota or network); using Esri Satellite',
          },
        };
      const imagery =
        descriptor.kind === 'ion'
          ? () => createIonImagery(descriptor.style, ionToken)
          : descriptor.id === 'osm'
            ? createOsmImagery
            : createEsriImagery;
      return {
        ...common,
        imagery,
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
