import { retainsLayerSession } from '../app/layerSession.js';
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
import { engineOfChoice, resolveEngineKind } from '../app/engineChoice.js';
import { createSceneHost } from '../app/sceneHost.js';
import { attachScenePart } from '../app/sceneParts.js';
import { loadLayerRenderers } from '../app/layers/renderers.js';

// Only one engine may own the page at a time.
let owner = null;

/** The abort reason of a released globe, made once at module load. */
const SCENE_RELEASED = new DOMException('The globe was released', 'AbortError');

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

/** The page-session state shared by every application on that session. */
function sessionChrome(layerSession) {
  return (layerSession.chrome ??= {});
}

/**
 * Compose the page's application, created once per page. Its first globe is
 * `engineKind`; `attachScene(kind)` and `detachScene()` switch engines by
 * detaching and attaching only the engine-bound parts (src/app/sceneHost.js)
 * while the shell, stores, voice, tools and layer models stay. Destroy it
 * before creating another.
 */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  geospatial = {},
  voice = {},
  sources = {},
  streetLevelProviders,
  allowQaRegistration = false,
  engineKind = pageEngineKind(),
  rendererCache,
  layerSession,
  engineSwitch = false,
  transition: startupTransition = null,
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
  let qaSources = {};
  // The engine-bound parts of every phase attach through this host.
  const sceneHost = createSceneHost({
    transitionHost: startupTransition?.host,
    onError: (error, part) =>
      console.error(`The ${part} scene part failed:`, error),
  });
  // The attached globe (one renderer attachment with its catalog), or null
  // between engines.
  let current = null;
  let lifetime = null;
  let sessionContext = null;
  let cleanupTransition = null;

  /** Acquire `kind`'s renderer and build its catalog: one attachment. */
  async function openScene(kind) {
    const controller = new AbortController();
    const releases = [];
    let releasing;
    const release = () => (releasing ??= releaseResources());
    const releaseResources = async () => {
      // A reason made here would keep this call's stack, and with it the
      // released scene, alive in every closure that still holds `signal`.
      controller.abort(SCENE_RELEASED);
      const errors = [];
      while (releases.length) {
        try {
          await releases.pop()();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'The globe could not be released');
    };
    const signal = AbortSignal.any([controller.signal, lifetime]);
    // Shared layer displays and this engine's backends load beside its globe.
    const layerRenderers = loadLayerRenderers(engineOfChoice(kind));
    layerRenderers.catch(() => {});
    try {
      const scene = await createStandaloneScene({
        ...sessionContext,
        signal,
        defer: (cleanup) => releases.push(cleanup),
        googleApiKey,
        // Without a key, Google 3D can still load with tokens from the
        // app's server when it offers them.
        googleTokens: googleApiKey ? null : createGoogleTokenSource(),
        cesiumToken,
        loaderStatus,
        engineKind: kind,
        rendererCache,
        layerSession,
      });
      signal.throwIfAborted();
      await layerRenderers;
      signal.throwIfAborted();
      // The catalog of this engine: only the layers it can show (the layer
      // manifest, src/app/layers/renderers.js), the others' state kept for
      // links. The layer models are the session's (layerSession.models).
      // Session models keep the catalog's closures past this scene: they
      // capture the operations, never the scene (it holds the engine).
      const { operations } = scene;
      const sceneCatalog = createStandaloneCatalog({
        engineKind: engineOfChoice(kind),
        layerSession,
        sources: { ...sources, ...qaSources },
        streetLevelProviders,
        nepalBoundaryResolver: (resolverSignal) =>
          operations.annotationResolver.resolveRegionRingForQuery(
            'Nepal',
            resolverSignal,
            placeSearch,
            // The locator draws the border whenever it arrives.
            { budgetMs: Infinity },
          ),
        signal,
        surface: operations.surface,
      });
      return Object.freeze({
        ...scene,
        signal,
        kind,
        catalog: sceneCatalog,
        release,
      });
    } catch (error) {
      await release().catch((cleanupError) =>
        console.error('A failed globe could not be released:', cleanupError),
      );
      throw error;
    }
  }

  // What the phases and the page read as `scene`: the attached globe's
  // handles (null between engines), the session's operations and the host.
  const sceneView = Object.freeze({
    get kind() {
      return current?.kind ?? null;
    },
    get viewer() {
      return current?.viewer ?? null;
    },
    get engine() {
      return current?.engine ?? null;
    },
    get tileset() {
      return current?.tileset ?? null;
    },
    get mapStackController() {
      return current?.mapStackController ?? null;
    },
    get catalog() {
      return current?.catalog ?? null;
    },
    get operations() {
      return layerSession?.operations ?? current?.operations ?? null;
    },
    get transaction() {
      return cleanupTransition ?? startupTransition;
    },
    current: () => current,
    sceneHost,
  });

  const application = createApplication({
    createScene: async (context) => {
      lifetime = context.signal;
      // The page's language listener and place search belong to the page
      // session when there is one (an engine switch keeps them), else to
      // this application.
      const session = layerSession ? sessionChrome(layerSession) : null;
      // A language switch applies in place; the page's own markup follows.
      if (!session?.locale) {
        const offLocale = onLocaleChange(() => {
          applyDocumentLanguage(document, getLocale());
          applyDocumentTranslations(document);
        });
        if (session) {
          session.locale = offLocale;
          layerSession.lifetime.signal.addEventListener('abort', offLocale, {
            once: true,
          });
        } else context.defer(offLocale);
      }
      const createPlaceSearch = (signal) =>
        createStandalonePlaceSearch({
          // The bundled city and landmark data the offline name provider
          // reads. The search package takes it as plain data rather than
          // importing it, so it stays free of application state.
          presets: CITY_POIS,
          ...geospatial,
          resolveApiKey: () => googleApiKey,
          signal,
        });
      placeSearch = session
        ? (session.placeSearch ??= createPlaceSearch(
            layerSession.lifetime.signal,
          ))
        : createPlaceSearch(context.signal);
      // QA fixture sources (?qaFeed=…) on the dev server only.
      const search = globalThis.location?.search ?? '';
      // import.meta.env.DEV at the import site, so production builds drop
      // the chunk instead of shipping it unreachable.
      qaSources =
        import.meta.env?.DEV &&
        allowQaRegistration &&
        /[?&]qaFeed=/.test(search)
          ? await import('../app/layers/qaSources.js').then(
              ({ createQaSources, parseQaFeed }) =>
                createQaSources(parseQaFeed(search)),
            )
          : {};
      // The session's own defer (its logo gaze and key when no layer
      // session holds them) outlives every globe.
      sessionContext = { defer: context.defer };
      // The renderer is released after its parts, including a failed start.
      context.defer(() =>
        detachScene(
          {
            handoff: retainsLayerSession(layerSession),
          },
          sceneView.transaction,
        ),
      );
      await sceneHost.run(async (transaction) => {
        current = await openScene(engineKind);
        // The first globe: the phases build on it and register their parts.
        await sceneHost.attach(current, transaction);
      }, startupTransition);
      return sceneView;
    },
    createControls: (context) =>
      createStandaloneControls({
        ...context,
        engineSwitch,
        layerSession,
        loaderStatus,
        placeSearch,
        catalog: current.catalog,
      }),
    createData: (context) =>
      createStandaloneData({
        ...context,
        allowQaRegistration,
        catalog: current.catalog,
        layerSession,
      }),
    createTools: async (context) => {
      const tools = await createStandaloneTools({
        ...context,
        layerSession,
        loadingScreen,
        placeSearch,
        voice,
      });
      // The engine-neutral QA probe on the debug handle (src/app/qaProbe.js),
      // on the dev server only: import.meta.env.DEV at the import site, so
      // production builds drop it. It reads one engine: a part.
      const debug = globalThis.window?.__godsEyeView;
      if (import.meta.env?.DEV && debug) {
        const { createQaProbe } = await import('../app/qaProbe.js');
        await attachScenePart(
          context.scene,
          {
            name: 'qa-probe',
            attachScene(next, { defer }) {
              const probe = createQaProbe({
                engine: next.engine,
                dataManager: context.data.dataManager,
              });
              debug.layers = probe;
              defer(() => {
                probe.destroy();
                if (debug.layers === probe) delete debug.layers;
              });
            },
          },
          { defer: context.defer },
        );
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

  /**
   * Switch to `kind`: acquire its renderer and attach every part. A failure
   * detaches what attached and releases the candidate; the session stays as
   * it was, ready for the working engine to attach again.
   */
  function attachScene(kind, { resume, transaction } = {}) {
    return sceneHost.run(
      (transaction) => attach(kind, resume, transaction),
      transaction,
    );
  }

  async function attach(kind, resume, transaction) {
    if (application.getState().status !== 'ready')
      throw new Error('The application is not running');
    if (current) throw new Error('A globe is attached; detach it first');
    const next = await openScene(kind);
    try {
      await sceneHost.attach(next, transaction);
      current = next;
      await resume?.();
      lifetime.throwIfAborted();
    } catch (error) {
      // attach() releases partial parts itself; a failed resume leaves a
      // complete attachment for this transaction to detach.
      if (current === next) {
        current = null;
        await sceneHost
          .detach({ handoff: !lifetime.aborted }, transaction)
          .catch((cleanupError) =>
            console.error(
              'A failed globe could not be released:',
              cleanupError,
            ),
          );
      }
      await next
        .release()
        .catch((cleanupError) =>
          console.error('A failed globe could not be released:', cleanupError),
        );
      throw error;
    }
    return sceneView;
  }

  /** Detach every part from the attached globe and park or release it. */
  function detachScene(options = {}, transaction) {
    return sceneHost.run(
      (transaction) => detach(options, transaction),
      transaction,
    );
  }

  async function detach(options, transaction) {
    const scene = current;
    if (!scene) return;
    try {
      await sceneHost.detach(options, transaction);
    } finally {
      current = null;
      await scene.release();
    }
  }

  return Object.freeze({
    ...application,
    async start() {
      try {
        return await application.start();
      } finally {
        startupTransition = null;
      }
    },
    async destroy(transaction) {
      cleanupTransition ??= transaction;
      try {
        await application.destroy();
        await sceneHost.dispose(transaction);
      } finally {
        cleanupTransition = null;
      }
    },
    sceneHost,
    attachScene,
    detachScene,
  });
}
