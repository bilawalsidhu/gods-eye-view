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
export const approximateSurfaceDistanceM = layer.approximateSurfaceDistanceM;
export const classifyGoogleMilitaryPlace = layer.classifyGoogleMilitaryPlace;
export const installationSourceLabel = layer.installationSourceLabel;
export const installationSurfaceHeightM = layer.installationSurfaceHeightM;
export const installationWithinViewport = layer.installationWithinViewport;
export const installationResponseSaturated =
  layer.installationResponseSaturated;
export const installationRetryDelayMs = layer.installationRetryDelayMs;
export default layer;
