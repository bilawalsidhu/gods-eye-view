import { createSourceSlot } from '../app/sourceSlot.js';
import {
  createInstallationsLayer,
  createInstallationSource,
} from '../layers/installations/index.js';
import * as render from '../renderGovernor.js';
import * as context from './contextStore.js';
import * as ground from './groundFloor.js';
import * as anchors from './fireAnchors.js';
import * as picking from './pickRegistry.js';

const sourceSlot = createSourceSlot(
  createInstallationSource(),
  ['getMappedSites', 'searchNearby'],
  'Installation source',
);
export const configureInstallationSource = sourceSlot.configure;
const layer = createInstallationsLayer({
  source: sourceSlot.source,
  services: { render, context, ground, anchors, picking },
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
