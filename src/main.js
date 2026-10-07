import { createStandaloneApplication } from './standalone/application.js';
import { initDemonForge } from './demonForge/controller.js';
import { createDemonForgeVault } from './demonForge/vault.js';
import { describeError } from './standalone/errors.js';
import { initDiscovery } from './discovery/controller.js';
import { createDiscoveryBridge } from './standalone/discoveryBridge.js';
import './discovery/discovery.css';
import { initAreaWorkspace } from './demonForge/areaController.js';
import {
  observedArea,
  loadInvestigationCatalog,
} from './standalone/investigationBridge.js';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});
const discovery = initDiscovery({
  document,
  ...createDiscoveryBridge(application),
});
window.addEventListener('beforeunload', () => discovery.destroy(), {
  once: true,
});

const demonForge = initDemonForge({ document, vault: createDemonForgeVault() });
const areaWorkspace = initAreaWorkspace({
  document,
  vault: createDemonForgeVault({
    databaseName: 'gods-eye-view.area-investigation.v1',
  }),
  getArea: (radius) => observedArea(application, radius),
  loadCatalog: loadInvestigationCatalog,
});
window.addEventListener('beforeunload', () => demonForge.destroy(), {
  once: true,
});
window.addEventListener('beforeunload', () => areaWorkspace.destroy(), {
  once: true,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
