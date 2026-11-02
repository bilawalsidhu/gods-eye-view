import { createStandaloneCatalog } from './catalog.js';
import { createStandalonePlaceSearch } from './placeSearch.js';
import { CITY_POIS } from '../cityPois.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { resolveLocale, applyDocumentLanguage } from '../i18n/locale.js';
import {
  applyDocumentTranslations,
  getLocale,
  onLocaleChange,
  setLocale,
} from '../i18n/index.js';
import { mountApplicationViews } from '../ui/views/index.js';
import { createGoogleTokenSource } from '../maps/googleTokens.js';
import { resolveEngineKind } from '../app/engineChoice.js';

// Only one engine may own the page at a time.
let owner = null;

/** The page's engine choice: ?engine=, else the stored gev.engine, else Cesium. */
export function pageEngineKind() {
  let storage = null;
  try {
    storage = globalThis.localStorage ?? null;
  } catch {
    // Blocked storage reads as no stored choice.
  }
  return resolveEngineKind({ search: globalThis.location?.search, storage });
}

/** Compose one engine session. Destroy it before starting another. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  geospatial = {},
  voice = {},
  sources = {},
  streetLevelProviders,
  allowQaRegistration = false,
  engineKind = pageEngineKind(),
}) {
  if (owner)
    throw new Error('The standalone application already owns this page');
  // Locale is resolved before any UI initialization so <html lang>/<html dir>
  // and every catalog lookup agree from the first painted frame. Module
  // scripts execute after parsing, so the DOM is ready here: the views
  // translate as they render, and the page's static data-i18n* markup (the
  // loading screen) is translated here and after every language switch.
  const activeLocale = resolveLocale();
  setLocale(activeLocale);
  applyDocumentLanguage(document, activeLocale);
  // Views render the page's markup; wiring reads it.
  mountApplicationViews(document);
  applyDocumentTranslations(document);
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  let placeSearch;
  let catalog;
  const application = createApplication({
    createScene: async (context) => {
      // A language switch applies in place; the page's own markup follows.
      context.defer(
        onLocaleChange(() => {
          applyDocumentLanguage(document, getLocale());
          applyDocumentTranslations(document);
        }),
      );
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
        googleApiKey,
        // Without a key, Google 3D can still load with tokens from the
        // app's server when it offers them.
        googleTokens: googleApiKey ? null : createGoogleTokenSource(),
        cesiumToken,
        loaderStatus,
        engineKind,
      });
      // The catalog of this engine: on Navara only the layers with a Navara
      // renderer (src/app/layers/renderers.js; none yet), the others' state
      // kept for links.
      // QA fixture sources (?qaFeed=…) on the dev server only.
      const search = globalThis.location?.search ?? '';
      // import.meta.env.DEV at the import site, so production builds drop
      // the chunk instead of shipping it unreachable.
      const qaSources =
        import.meta.env?.DEV &&
        allowQaRegistration &&
        /[?&]qaFeed=/.test(search)
          ? await import('../app/layers/qaSources.js').then(
              ({ createQaSources, parseQaFeed }) =>
                createQaSources(parseQaFeed(search)),
            )
          : {};
      catalog = createStandaloneCatalog({
        engineKind,
        sources: { ...sources, ...qaSources },
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
    createTools: async (context) => {
      const tools = await createStandaloneTools({
        ...context,
        loadingScreen,
        placeSearch,
        voice,
      });
      // The engine-neutral QA probe on the debug handle (src/app/qaProbe.js),
      // on the dev server only: import.meta.env.DEV at the import site, so
      // production builds drop it.
      const debug = globalThis.window?.__godsEyeView;
      if (import.meta.env?.DEV && debug) {
        const { createQaProbe } = await import('../app/qaProbe.js');
        const probe = createQaProbe({
          engine: context.scene.engine,
          dataManager: context.data.dataManager,
          availability: catalog.availability,
        });
        debug.layers = probe;
        context.defer(() => {
          probe.destroy();
          if (debug.layers === probe) delete debug.layers;
        });
      }
      return tools;
    },
  });
  owner = application;
  application.subscribe(({ status }) => {
    if (
      (status === 'destroyed' || status === 'failed') &&
      owner === application
    )
      owner = null;
  });
  return application;
}
