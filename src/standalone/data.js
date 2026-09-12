import { DataLayerManager } from '../data/manager.js';
import flightsLayer from '../data/flights.js';
import militaryFlightsLayer from '../data/militaryFlights.js';
import earthquakesLayer from '../data/earthquakes.js';
import satellitesLayer from '../data/satellites.js';
import rocketLaunchesLayer from '../data/rocketLaunches.js';
import trafficLayer from '../data/traffic.js';
import cctvLayer from '../data/cctv.js';
import radioLayer from '../data/radio.js';
import bikeshareLayer from '../data/bikeshare.js';
import aisLiveVesselsLayer from '../data/aisLiveVessels.js';
import militaryInstallationsLayer from '../data/militaryInstallations.js';
import militaryAwarenessLayer from '../data/militaryAwareness.js';
import localDataLayers from '../data/localLayers.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';

/** Register the standalone layer catalog before allowing state restoration. */
export function createStandaloneData({
  scene: { viewer },
  controls: { styleManager },
  allowQaRegistration,
  defer,
}) {
  // Initialize data layer manager
  const dataManager = new DataLayerManager(viewer, {
    allowQaRegistration,
  });
  defer(async () => {
    await dataManager.destroyAll();
    if (dataManager.layers.size)
      throw new Error(
        `Data layers could not be destroyed: ${[...dataManager.layers.keys()].join(', ')}`,
      );
  });
  dataManager.register(flightsLayer);
  dataManager.register(militaryFlightsLayer);
  dataManager.register(earthquakesLayer);
  dataManager.register(satellitesLayer);
  dataManager.register(rocketLaunchesLayer);
  rocketLaunchesLayer.attachDataManager(dataManager);
  dataManager.register(trafficLayer);
  dataManager.register(cctvLayer);
  dataManager.register(radioLayer);
  dataManager.register(bikeshareLayer);
  dataManager.register(aisLiveVesselsLayer);
  dataManager.register(militaryInstallationsLayer);
  dataManager.register(militaryAwarenessLayer);
  militaryAwarenessLayer.attachDataManager(dataManager);
  for (const layer of localDataLayers) {
    dataManager.register(layer);
  }
  // Restoration starts only after the complete production registry is sealed.
  dataManager.finalizeRegistrations(LAYER_STATE_REGISTRY);
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
  dataManager.buildTogglePanel(document.getElementById('data-toggles'));
  styleManager.attachDataManager(dataManager);

  return { dataManager };
}
