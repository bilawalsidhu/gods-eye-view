import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerPresentation } from './layerPresentation.js';
import { createCyberSonarScene } from '../cyberSonarScene.js';
import { panelAwareVisibility } from './embed.js';
/** Register the application layer catalog before allowing state restoration. */
export function createApplicationData({
  scene: { viewer, engine, mapStackController },
  controls: { styleManager },
  catalog,
  allowQaRegistration,
  layerSession,
  onData,
  defer,
}) {
  // Initialize data layer manager
  // The modules get { signal, engine } on every call (viewer null on Navara).
  const dataManager = layerSession?.manager ?? new LayerLifecycle(viewer, {
    engine,
    allowQaRegistration,
    // A panel's host may report it hidden while it is on screen; its layers
    // keep polling (see keepPanelRendering in embed.js).
    visibilityTarget: panelAwareVisibility(document),
    getSourceAvailability: catalog?.getSourceAvailability,
  });
  if (layerSession) layerSession.manager = dataManager;
  defer(async () => {
    if (layerSession && !layerSession.lifetime.signal.aborted) {
      await dataManager.detachScene();
      return;
    }
    await dataManager.destroyAll();
    if (dataManager.layers.size)
      throw new Error(
        `Data layers could not be destroyed: ${[...dataManager.layers.keys()].join(', ')}`,
      );
  });
  const presentation = layerSession?.presentation ?? new LayerPresentation(dataManager, {
    weatherClock: catalog?.weatherClock,
  });
  if (layerSession) layerSession.presentation = presentation;
  defer(() => {
    if (layerSession && !layerSession.lifetime.signal.aborted) presentation.suspend();
    else presentation.destroy();
  });
  onData?.(dataManager);
  if (!catalog?.layers || !catalog?.metadata)
    throw new TypeError('An application layer catalog is required');
  dataManager.bindCatalog(viewer, engine, catalog);
  for (const layer of catalog.layers) layer.attachDataManager?.(dataManager);
  for (const layer of catalog.layers)
    layer.attachMapStackController?.(mapStackController);

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
  presentation.mount(document.getElementById('data-toggles'), catalog.weatherClock);
  styleManager.attachDataManager(dataManager);
  // The sonar scene draws on the viewer; the Navara engine has none.
  if (viewer) defer(createCyberSonarScene(viewer, dataManager));

  return { dataManager, catalog, presentation };
}
