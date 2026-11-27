import { defaultSurface } from './surfaceServices.js';
import { createApplicationInstallations } from '../app/layers/militaryInstallations.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createInstallationSource } from '../layers/installations/index.js';

const sourceSlot = createSourceSlot(
  createInstallationSource(),
  ['getMappedSites', 'searchNearby'],
  'Installation source',
  { destroy: () => {} },
);
export const configureInstallationSource = sourceSlot.configure;
const layer = createApplicationInstallations({
  surface: defaultSurface,
  source: sourceSlot.source,
});
export const installationSurfaceHeightM = layer.installationSurfaceHeightM;
export default layer;
