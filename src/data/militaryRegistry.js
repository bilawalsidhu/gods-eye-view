import { createMilitaryRegistry } from '../layers/aircraft/classification.js';
import { createAdsbLolSource } from '../sources/live/standalone.js';

const registry = createMilitaryRegistry({ source: createAdsbLolSource() });
export const isMilitaryLayerActive = registry.isMilitaryLayerActive;
export const setMilitaryLayerActive = registry.setMilitaryLayerActive;
export const onMilitaryLayerActiveChange = registry.onMilitaryLayerActiveChange;
export const registerMilitaryIcaos = registry.registerMilitaryIcaos;
export const isMilitaryIcao = registry.isMilitaryIcao;
export const refreshMilitaryRegistryIfStale =
  registry.refreshMilitaryRegistryIfStale;
