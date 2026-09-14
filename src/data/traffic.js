import { createSourceSlot } from '../app/sourceSlot.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createTrafficLayer } from '../layers/traffic/index.js';
import * as credits from './dataCredits.js';
import * as render from '../renderGovernor.js';

const sourceSlot = createSourceSlot(
  createTrafficSource(),
  ['requestRoads', 'getStatus', 'fetchFlowForBounds'],
  'Traffic source',
  {
    getFlowSessionStats: () => ({ tilesFetched: 0 }),
    resetFlowTileCache: () => {},
  },
);
export const configureTrafficSource = sourceSlot.configure;
const layer = createTrafficLayer({
  source: sourceSlot.source,
  services: { credits, render },
});
export const getTrafficTimingDiagnostics = layer.getTrafficTimingDiagnostics;
export const deriveTrafficFlowError = layer.deriveTrafficFlowError;
export const trafficFeedPresentation = layer.trafficFeedPresentation;
export default layer;
