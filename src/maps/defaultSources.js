import { MAP_STACKS } from './catalog.js';
import { photorealUnavailableReason } from './availability.js';
import { keySetupRequirementEnvVars } from '../keySetupCore.mjs';
import { t } from '../i18n/index.js';
import { mapEngine } from './engine.js';
import { ESRI_ATTRIBUTION_HTML } from './attribution.js';

/**
 * Select sources and setup guidance without putting provider branches in the
 * controller. Each source builds its imagery and terrain through the
 * `engine` given (the scene's map engine, `engine.js`), else the one the
 * adapter provided for viewers with no renderer, when it is first shown.
 */
export function createDefaultMapSources({
  googleTileset = null,
  cesiumToken = '',
  googleApiKey = '',
  engine = null,
} = {}) {
  const engineOf = () => engine ?? mapEngine();
  const ionToken = String(cesiumToken || '').trim();
  const hasIon = Boolean(ionToken);
  const hasGoogle = Boolean(String(googleApiKey || '').trim());
  const terrain = {
    id: hasIon ? 'world' : 'keyless',
    create: hasIon
      ? (request) => engineOf().terrain.world(ionToken, request)
      : () => engineOf().terrain.keyless(),
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
      const imagery =
        descriptor.kind === 'ion'
          ? () => engineOf().imagery.ion(descriptor.style, ionToken)
          : descriptor.id === 'osm'
            ? () => engineOf().imagery.osm()
            : () => engineOf().imagery.esri();
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
