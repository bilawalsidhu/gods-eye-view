import { createStandaloneCatalog } from './catalog.js';
import { createStandalonePlaceSearch } from './placeSearch.js';
import { CITY_POIS } from '../cityPois.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { resolveLocale, applyDocumentLanguage } from '../i18n/locale.js';
import { applyDocumentTranslations, setLocale } from '../i18n/index.js';
import { createGoogleTokenSource } from '../maps/googleTokens.js';
import { shouldUseDirect } from '../mobile/sourcePolicy.js';
import {
  createApplicationKeyReader,
  resolveSceneKeys,
} from '../mobile/vaultKeys.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/** Compose the standalone application once per page. Reload to start again. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  geospatial = {},
  voice = {},
  sources = {},
  streetLevelProviders,
  allowQaRegistration = false,
}) {
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
  // Locale is resolved before any UI initialization so <html lang>/<html dir>
  // and every catalog lookup agree from the first painted frame. Module
  // scripts execute after parsing, so the DOM is ready here and every
  // data-i18n* element honors the resolved locale without a reload.
  const activeLocale = resolveLocale();
  setLocale(activeLocale);
  applyDocumentLanguage(document, activeLocale);
  applyDocumentTranslations(document);
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  let placeSearch;
  let catalog;
  return createApplication({
    createScene: async (context) => {
      placeSearch = createStandalonePlaceSearch({
        // The bundled city and landmark data the offline name provider reads.
        // The search package takes it as plain data rather than importing it,
        // so it stays free of application state.
        presets: CITY_POIS,
        ...geospatial,
        resolveApiKey: () => googleApiKey,
        signal: context.signal,
      });
      // On-device without a backend, map keys come from the vault rather
      // than the build, so photorealistic 3D needs no baked keys. The
      // resolver is fail-closed: without stored tokens the build values
      // (usually empty on mobile) stand and the keyless globe boots.
      const sceneKeys = await resolveSceneKeys({
        getVaultKey: createApplicationKeyReader(),
        googleApiKey,
        cesiumToken,
        direct: shouldUseDirect(),
      });
      const scene = await createStandaloneScene({
        ...context,
        googleApiKey: sceneKeys.googleApiKey,
        // Without a key, Google 3D can still load with tokens from the
        // app's server when it offers them.
        googleTokens: sceneKeys.googleApiKey ? null : createGoogleTokenSource(),
        cesiumToken: sceneKeys.cesiumToken,
        loaderStatus,
      });
      catalog = createStandaloneCatalog({
        sources,
        streetLevelProviders,
        getKey: createApplicationKeyReader(),
        mapillaryToken: sceneKeys.mapillaryToken,
        nepalBoundaryResolver: (signal) =>
          scene.operations.annotationResolver.resolveRegionRingForQuery(
            'Nepal',
            signal,
            placeSearch,
            // The locator draws the border whenever it arrives.
            { budgetMs: Infinity },
          ),
        signal: context.signal,
        surface: scene.operations.surface,
      });
      return scene;
    },
    createControls: (context) =>
      createStandaloneControls({
        ...context,
        loaderStatus,
        placeSearch,
        catalog,
      }),
    createData: (context) =>
      createStandaloneData({ ...context, allowQaRegistration, catalog }),
    createTools: (context) =>
      createStandaloneTools({ ...context, loadingScreen, placeSearch, voice }),
  });
}
