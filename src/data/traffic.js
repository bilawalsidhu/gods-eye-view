import { createApplicationTraffic } from '../app/layers/traffic.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createObservedTrafficSource } from '../layers/traffic/observed.js';

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

const observedSourceSlot = createSourceSlot(
  createObservedTrafficSource(),
  ['request'],
  'Observed traffic source',
);
export const configureObservedTrafficSource = observedSourceSlot.configure;

const layer = createApplicationTraffic({
  source: sourceSlot.source,
  observedSource: observedSourceSlot.source,
});
export const getTrafficTimingDiagnostics = layer.getTrafficTimingDiagnostics;
export const deriveTrafficFlowError = layer.deriveTrafficFlowError;
export const trafficFeedPresentation = layer.trafficFeedPresentation;
export const getObservedTrafficSnapshot = layer.getObservedTrafficSnapshot;
export const refreshObservedTraffic = layer.refreshObservedTraffic;
export const subscribeObservedTraffic = layer.subscribeObservedTraffic;
export default layer;
