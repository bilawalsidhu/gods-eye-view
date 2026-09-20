import { createApplicationTraffic } from '../app/layers/traffic.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createTrafficSource } from '../layers/traffic/source.js';

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
const layer = createApplicationTraffic({
  source: sourceSlot.source,
});
export const getTrafficTimingDiagnostics = layer.getTrafficTimingDiagnostics;
export const deriveTrafficFlowError = layer.deriveTrafficFlowError;
export const trafficFeedPresentation = layer.trafficFeedPresentation;
export default layer;
