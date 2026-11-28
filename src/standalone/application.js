import { createStandaloneCatalog } from './catalog.js';
import { createStandalonePlaceSearch } from './placeSearch.js';
import { CITY_POIS } from '../cityPois.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene, loadDefaultRenderer } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { applyDocumentTranslations, followPageLocale } from '../i18n/page.js';
import { mountApplicationViews } from '../ui/views/index.js';
import { createGoogleTokenSource } from '../maps/googleTokens.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/**
 * Compose the standalone application once per page, after the page's locale
 * has started (`await startPageLocale(document)`). Reload to start again.
 * `renderer` is the renderer plugin it draws with (default: Cesium).
 */
export function createStandaloneApplication({
  renderer,
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
  // The default renderer starts loading now, beside the page's own setup.
  // A failed load is the scene's to report, when it asks for the renderer.
  const rendererPlugin = renderer ?? loadDefaultRenderer();
  if (!renderer) Promise.resolve(rendererPlugin).catch(() => {});
  // The page's locale is started (startPageLocale, awaited by the entry)
  // before this runs, so <html lang>/<html dir> and every catalog lookup
  // agree from the first painted frame. Module scripts execute after
  // parsing, so the DOM is ready here: the views translate as they render,
  // and the page's static data-i18n* markup (the loading screen) is
  // translated here and after every language switch.
  // Views render the page's markup; wiring reads it.
  mountApplicationViews(document);
  applyDocumentTranslations(document);
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  let placeSearch;
  let catalog;
  return createApplication({
    createScene: async (context) => {
      // A language switch applies in place; the page's own markup follows.
      context.defer(followPageLocale(document));
      placeSearch = createStandalonePlaceSearch({
        // The bundled city and landmark data the offline name provider reads.
        // The search package takes it as plain data rather than importing it,
        // so it stays free of application state.
        presets: CITY_POIS,
        ...geospatial,
        resolveApiKey: () => googleApiKey,
        signal: context.signal,
      });
      const scene = await createStandaloneScene({
        ...context,
        // The renderer plugin; the default (Cesium) when none is given.
        renderer: rendererPlugin,
        googleApiKey,
        // Without a key, Google 3D can still load with tokens from the
        // app's server when it offers them.
        googleTokens: googleApiKey ? null : createGoogleTokenSource(),
        cesiumToken,
        loaderStatus,
      });
      catalog = createStandaloneCatalog({
        sources,
        streetLevelProviders,
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
