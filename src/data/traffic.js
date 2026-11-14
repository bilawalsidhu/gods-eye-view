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
    // The layer reads stale cached tiles through this; a source without it
    // answers with fresh segments only.
    fetchFlowDetail: async (...args) => ({
      segments: await sourceSlot.source.fetchFlowForBounds(...args),
      stale: false,
      oldestTileAt: null,
    }),
  },
);
export const configureTrafficSource = sourceSlot.configure;
/** The source the traffic layer reads, as configured. */
export const trafficSource = sourceSlot.source;
const layer = createApplicationTraffic({
  source: sourceSlot.source,
});
export const getTrafficTimingDiagnostics = layer.getTrafficTimingDiagnostics;
export const deriveTrafficFlowError = layer.deriveTrafficFlowError;
export const trafficFeedPresentation = layer.trafficFeedPresentation;
export default layer;
