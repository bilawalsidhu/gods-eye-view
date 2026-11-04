import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerPresentation } from './layerPresentation.js';
import { LayerOpacity } from '../ui/layerOpacity.js';
import { governorRequestRender } from '../renderGovernor.js';
import { createCyberSonarScene } from '../cyberSonarScene.js';
import { isEmbeddedInline, panelAwareVisibility } from './embed.js';
/** Register the application layer catalog before allowing state restoration. */
export function createApplicationData({
  scene: { viewer, mapStackController },
  controls: { styleManager },
  catalog,
  allowQaRegistration,
  onData,
  defer,
}) {
  // Initialize data layer manager
  const dataManager = new LayerLifecycle(viewer, {
    allowQaRegistration,
    // A panel's host may report it hidden while it is on screen; its layers
    // keep polling (see keepPanelRendering in embed.js).
    visibilityTarget: panelAwareVisibility(document),
    getSourceAvailability: catalog?.getSourceAvailability,
  });
  defer(async () => {
    await dataManager.destroyAll();
    if (dataManager.layers.size)
      throw new Error(
        `Data layers could not be destroyed: ${[...dataManager.layers.keys()].join(', ')}`,
      );
  });
  // The opacity of the layers that can be dimmed; the panel presents it and
  // the page address carries it (`?lop=`).
  // An app embedded inline lives in its host's page: it reads the address but
  // leaves the host's query alone.
  const opacity = new LayerOpacity(dataManager, {
    historyRef: isEmbeddedInline() ? null : globalThis.history,
    requestRender: () => governorRequestRender('layer-opacity'),
  });
  defer(() => opacity.destroy());
  const presentation = new LayerPresentation(dataManager, {
    weatherClock: catalog?.weatherClock,
    opacity,
  });
  defer(() => presentation.destroy());
  onData?.(dataManager);
  if (!catalog?.layers || !catalog?.metadata)
    throw new TypeError('An application layer catalog is required');
  for (const layer of catalog.layers) dataManager.register(layer);
  for (const layer of catalog.layers) layer.attachDataManager?.(dataManager);
  for (const layer of catalog.layers)
    layer.attachMapStackController?.(mapStackController);
  // Restoration starts only after the caller's complete registry is sealed.
  dataManager.finalizeRegistrations(catalog.metadata);
  opacity.restore();
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
  presentation.mount(document.getElementById('data-toggles'));
  styleManager.attachDataManager(dataManager);
  defer(createCyberSonarScene(viewer, dataManager));

  return { dataManager, catalog, presentation, opacity };
}
