import { MAP_STACKS } from './catalog.js';
import { photorealUnavailableReason } from './availability.js';
import { keySetupRequirementEnvVars } from '../keySetupCore.mjs';
import {
  imageryFactoryFor,
  ESRI_ATTRIBUTION_HTML,
} from '../globe/cesium/mapImagery.js';
import { terrainSourceFor } from '../globe/cesium/terrain.js';
import { t } from '../i18n/index.js';
import { localTilesetPath, qaTilesetUrl } from './qaTileset.js';

const navaraIonImageryReason = () =>
  t('Bing imagery is not available on the experimental Navara engine');

/**
 * Select sources and setup guidance without putting provider branches in the
 * controller. `engineKind` is the globe engine kind the sources are for: Cesium
 * builds them from the factories (photoreal needs its loaded tileset); Navara
 * builds them from the descriptions, so photoreal needs only the browser key
 * (Navara has no ion route to Google tiles) and Cesium ion imagery (Bing) is
 * unavailable.
 */
export function createDefaultMapSources({
  googleTileset = null,
  cesiumToken = '',
  googleApiKey = '',
  engineKind = 'cesium',
  tilesetUrl = qaTilesetUrl(),
} = {}) {
  if (engineKind !== 'cesium' && engineKind !== 'navara')
    throw new TypeError(`Unknown globe engine: ${engineKind}`);
  const navara = engineKind === 'navara';
  tilesetUrl = localTilesetPath(tilesetUrl);
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
  const photorealAvailable =
    Boolean(tilesetUrl) || (navara ? hasGoogle : Boolean(googleTileset));
  return {
    defaultId: photorealAvailable ? 'photoreal' : 'esri-imagery',
    unknownId: 'photoreal',
    recoveryId: photorealAvailable ? 'photoreal' : null,
    state: { hasCesiumIonToken: hasIon },
    sources: MAP_STACKS.map((descriptor) => {
      const ionImageryOnNavara = navara && descriptor.kind === 'ion';
      const common = {
        descriptor,
        available: !ionImageryOnNavara && (!descriptor.requiresIon || hasIon),
        // Read when shown, so it follows the locale.
        unavailableReason: ionImageryOnNavara
          ? navaraIonImageryReason
          : descriptor.requiresIon
            ? () =>
                t('Needs {envVars} — add it in Provider Settings', {
                  envVars: keySetupRequirementEnvVars('cesium-ion'),
                })
            : null,
      };
      if (descriptor.kind === 'photoreal')
        return {
          ...common,
          available: photorealAvailable,
          unavailableReason: () =>
            photorealUnavailableReason(
              navara ? hasGoogle : hasIon || hasGoogle,
            ),
          tileset: tilesetUrl ? null : googleTileset,
          ...(tilesetUrl && {
            tilesetUrl,
            createTileset: async (options) => {
              const { createQaTileset } =
                await import('../globe/cesium/qaTileset.js');
              return createQaTileset(tilesetUrl, options);
            },
          }),
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
