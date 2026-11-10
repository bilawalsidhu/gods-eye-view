/**
 * State that survives replacement of the globe. Each field names its owner;
 * scene attachments keep their own signals and never replace this lifetime.
 *
 * @typedef {object} LayerSession
 * @property {AbortController} lifetime Page owner: ends retained work.
 * @property {Map<string, object>} models Catalog: retained layer modules.
 * @property {import('../data/lifecycle.js').LayerLifecycle | null} manager Data phase.
 * @property {import('./layerPresentation.js').LayerPresentation | null} presentation Data phase.
 * @property {ReturnType<typeof import('./operations.js').createApplicationOperations> | null} operations Scene factory: session requests and surface caches.
 * @property {ReturnType<typeof import('../layers/aircraft/classification.js').createMilitaryRegistry> | null} militaryRegistry Catalog.
 * @property {ReturnType<typeof import('../layers/weather/clock.js').createWeatherClock> | null} weatherClock Catalog.
 * @property {import('../scenes/director.js').SceneDirector | null} director Tools phase.
 * @property {ReturnType<typeof import('../annotations/index.js').createSessionAnnotations> | null} annotations Session tools.
 * @property {{draw?: ReturnType<typeof import('../annotations/drawTool.js').createSessionDrawTool>, geoImport?: ReturnType<typeof import('../ui/geoFileImport.js').createGeoFileImport>}} tools Session tools.
 * @property {ReturnType<typeof import('../voice/gevRealtime.js').createSceneVoice> | null} voice Session voice.
 * @property {{locale?: () => void, placeSearch?: object, sceneChrome?: boolean}} chrome Standalone startup and scene factory.
 * @property {import('./sessionHandoff.js').SessionHandoff | null} handoff Switch coordinator: retained intentions and scene owners.
 * @property {Promise<void>} viewRestored Switch coordinator: incoming camera restoration.
 * @property {() => boolean} switching Switch coordinator: voice waits while busy.
 * @property {object | null} contextScene Shell: retained Context state.
 */

/** @returns {LayerSession} */
export function createLayerSession() {
  return {
    lifetime: new AbortController(),
    models: new Map(),
    manager: null,
    presentation: null,
    operations: null,
    militaryRegistry: null,
    weatherClock: null,
    director: null,
    annotations: null,
    tools: {},
    voice: null,
    chrome: {},
    handoff: null,
    viewRestored: Promise.resolve(),
    switching: () => false,
    contextScene: null,
  };
}

/** Whether teardown preserves the session for another globe. */
export function retainsLayerSession(session) {
  return Boolean(session?.handoff && !session.lifetime.signal.aborted);
}
