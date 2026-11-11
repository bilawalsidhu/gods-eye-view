import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerPresentation } from './layerPresentation.js';
import { createCyberSonarEngineScene } from '../cyberSonarEngine.js';
import { panelAwareVisibility } from './embed.js';
import { attachScenePart, currentSceneOf } from './sceneParts.js';

/**
 * Register the application layer catalog before allowing state restoration.
 * The layer manager and presentation belong to the application (to the page
 * session when there is one); each globe binds its catalog to them, and an
 * engine switch only detaches the layers' drawing (LayerLifecycle
 * detachScene).
 */
export function createApplicationData({
  scene,
  controls: { styleManager },
  catalog,
  allowQaRegistration,
  layerSession,
  onData,
  defer,
  signal = null,
}) {
  const first = currentSceneOf(scene);
  // Initialize data layer manager
  // The modules get { signal, engine } on every call (viewer null on Navara).
  const dataManager =
    layerSession?.manager ??
    new LayerLifecycle(first.viewer, {
      engine: first.engine,
      allowQaRegistration,
      // A panel's host may report it hidden while it is on screen; its layers
      // keep polling (see keepPanelRendering in embed.js).
      visibilityTarget: panelAwareVisibility(document),
      getSourceAvailability: catalog?.getSourceAvailability,
    });
  if (layerSession) layerSession.manager = dataManager;
  const sessionGoes = () =>
    !layerSession || layerSession.lifetime.signal.aborted;
  defer(async () => {
    if (!sessionGoes()) return;
    await dataManager.destroyAll();
    if (dataManager.layers.size)
      throw new Error(
        `Data layers could not be destroyed: ${[...dataManager.layers.keys()].join(', ')}`,
      );
  });
  const presentation =
    layerSession?.presentation ??
    new LayerPresentation(dataManager, {
      weatherClock: catalog?.weatherClock,
    });
  if (layerSession) layerSession.presentation = presentation;
  defer(() => {
    if (sessionGoes()) presentation.destroy();
  });
  onData?.(dataManager);
  if (!catalog?.layers || !catalog?.metadata)
    throw new TypeError('An application layer catalog is required');

  if (allowQaRegistration) {
    window.__gevQaRegisterLayer = (targetManager, layerModule) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.registerForQa(layerModule);
    };
    window.__gevQaUnregisterLayer = (targetManager, layerId) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.unregisterForQa(layerId);
    };
    const register = window.__gevQaRegisterLayer;
    const unregister = window.__gevQaUnregisterLayer;
    defer(() => {
      if (window.__gevQaRegisterLayer === register)
        delete window.__gevQaRegisterLayer;
      if (window.__gevQaUnregisterLayer === unregister)
        delete window.__gevQaUnregisterLayer;
    });
  }

  // Each globe binds its catalog: the layers' drawing, the Data panel and
  // the shell's layer bindings follow the engine.
  let current = catalog;
  const attached = attachScenePart(
    scene,
    {
      name: 'data',
      attachScene(next, { signal: attachment, defer: release }) {
        const nextCatalog = next.catalog ?? catalog;
        current = nextCatalog;
        for (const layer of nextCatalog.layers)
          layer.attachMapStackController?.(next.mapStackController);
        dataManager.viewer = next.viewer;
        const binding = dataManager.bindCatalog(next.engine, nextCatalog, {
          viewRestored: layerSession?.viewRestored,
        });
        for (const layer of nextCatalog.layers)
          layer.attachDataManager?.(dataManager);
        presentation.mount(
          document.getElementById('data-toggles'),
          nextCatalog.weatherClock,
        );
        styleManager.attachDataManager(dataManager);
        // The engine draws the sonar's contact treatment
        // (render.setContactSonar).
        release(createCyberSonarEngineScene(next.engine, dataManager));
        if (!binding) return;
        // A teardown or switch during the attachment must not wait for slow
        // layer attachments: it ends this wait, and the detach releases the
        // scene.
        return new Promise((resolve, reject) => {
          const waits = [signal, attachment].filter(Boolean);
          const onAbort = () => {
            for (const wait of waits)
              wait.removeEventListener('abort', onAbort);
            resolve();
          };
          if (waits.some((wait) => wait.aborted)) return onAbort();
          for (const wait of waits)
            wait.addEventListener('abort', onAbort, { once: true });
          binding.then(
            () => onAbort(),
            (error) => {
              for (const wait of waits)
                wait.removeEventListener('abort', onAbort);
              reject(error);
            },
          );
        });
      },
      async detachScene() {
        if (sessionGoes()) {
          await dataManager.destroyAll();
          return;
        }
        await dataManager.detachScene();
        presentation.suspend();
      },
    },
    { defer },
  );
  const data = {
    dataManager,
    get catalog() {
      return current;
    },
    presentation,
  };
  return attached?.then ? attached.then(() => data) : data;
}
