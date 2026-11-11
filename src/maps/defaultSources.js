import { MAP_STACKS } from './catalog.js';
import { photorealUnavailableReason } from './availability.js';
import { keySetupRequirementEnvVars } from '../keySetupCore.mjs';
import { t } from '../i18n/index.js';
import {
  createOsmImagery,
  createEsriImagery,
  createIonImagery,
  createTemplateImagery,
  templateCreditHtml,
  ESRI_ATTRIBUTION_HTML,
} from './imagery.js';
import { createWorldTerrain, createKeylessTerrain } from './terrain.js';

/** Select sources and setup guidance without putting provider branches in the controller. */
export function createDefaultMapSources({
  googleTileset = null,
  cesiumToken = '',
  googleApiKey = '',
  basemapUrl,
  basemapAttribution = '',
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
        // Read when shown, so it follows the locale.
        unavailableReason: descriptor.requiresIon
          ? () =>
              t('Needs {envVars} — add it in Provider Settings', {
                envVars: keySetupRequirementEnvVars('cesium-ion'),
              })
          : null,
      };
      if (descriptor.kind === 'photoreal')
        return {
          ...common,
          available: Boolean(googleTileset),
          unavailableReason: () =>
            photorealUnavailableReason(hasIon || hasGoogle),
          tileset: googleTileset,
        };
      if (descriptor.id === 'esri-imagery' && basemapUrl)
        // The operator's basemap takes Esri's place. It never falls back to
        // OSM: that would reach the public host the operator chose to avoid.
        return {
          ...common,
          descriptor: {
            ...descriptor,
            label: 'Basemap', // i18n-ignore: map source name, as the others
            shortLabel: 'MAP',
          },
          imagery: () => createTemplateImagery(basemapUrl),
          terrain,
          credit: basemapAttribution
            ? templateCreditHtml(basemapAttribution)
            : null,
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
