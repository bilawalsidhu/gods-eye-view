import { createStandaloneCatalog } from './catalog.js';
import { createStandalonePlaceSearch } from './placeSearch.js';
import { CITY_POIS } from '../locations.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { createGoogleTokenSource } from '../maps/googleTokens.js';
import { resolveEngineKind } from '../app/engineChoice.js';
import { createQaProbe } from '../app/qaProbe.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/** The page's engine choice: ?engine=, else the stored gev.engine, else Cesium. */
function pageEngineKind() {
  let storage = null;
  try {
    storage = globalThis.localStorage ?? null;
  } catch {
    // Blocked storage reads as no stored choice.
  }
  return resolveEngineKind({ search: globalThis.location?.search, storage });
}

/** Compose the standalone application once per page. Reload to start again. */
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
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
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
      const qaSources =
        allowQaRegistration && /[?&]qaFeed=/.test(search)
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
      // The engine-neutral QA probe on the debug handle (src/app/qaProbe.js).
      const debug = globalThis.window?.__godsEyeView;
      if (debug) {
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
}
